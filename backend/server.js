const { exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);
const fs = require('fs/promises');

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const Redis = require('redis');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE = 'https://api.github.com';
const REPO_STORAGE_PATH = path.join(__dirname, '..', 'repos');
const ORG_NAME = 'hust-open-atom-club';

// --- Utility Functions ---

/**
 * Introduces a delay to prevent hitting API rate limits.
 * @param {number} ms Milliseconds to wait.
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Formats a Date object to YYYY-MM-DD string.
 * @param {Date} date 
 */
const formatDate = (date) => {
    // getFullYear(), getMonth(), getDate() all return values based on the local timezone.
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0'); // getMonth() is 0-indexed
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// --- Database (PostgreSQL) Configuration ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// --- Cache (Redis) Configuration ---
const redisClient = Redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

async function connectRedis() {
    try {
        await redisClient.connect();
        console.log('Redis connected successfully.');
    } catch (e) {
        console.error('Failed to connect to Redis:', e.message);
    }
}

connectRedis();

async function retryWithBackoff(fn, retries = 3, delayMs = 1000) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            console.warn(`Attempt ${i + 1} failed. Retrying in ${delayMs / 1000}s... Error: ${error.message}`);
            await delay(delayMs);
            delayMs *= 2; // Exponential backoff
        }
    }
    throw lastError;
}

// --- Middleware ---
app.use(express.json());
// Allow CORS from the frontend development server (e.g., http://localhost:5173)
app.use(require('cors')({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST'],
}));

// --- GitHub API Utility ---

/**
 * Executes a REST API call against the GitHub API with a delay.
 */
async function githubRest(endpoint, params = {}) {
    if (!GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN is not set in environment variables.");
    }

    let allItems = [];
    let nextUrl = `${GITHUB_API_BASE}${endpoint}`;
    let isFirstPage = true;
    let totalCountFromApi = 0; // <-- 新增变量，用于存储真实的total_count

    while (nextUrl) {
        // 对于Search API，每分钟30次，每次请求之间间隔2秒足够（留出安全余量）
        await delay(2000);

        try {
            const response = await axios.get(nextUrl, {
                timeout: 30000,
                params: isFirstPage ? params : {},
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                }
            });

            // 如果是第一页，并且是Search API的返回结构，就记录下total_count
            if (isFirstPage && response.data.total_count !== undefined) {
                totalCountFromApi = response.data.total_count;
            }

            if (Array.isArray(response.data.items)) {
                allItems = allItems.concat(response.data.items);
            } else if (Array.isArray(response.data)) {
                allItems = allItems.concat(response.data);
                if (isFirstPage) totalCountFromApi = allItems.length; // 对于非search API，total_count就是数组长度
            }

            const linkHeader = response.headers.link;
            nextUrl = null;
            if (linkHeader) {
                const nextLink = linkHeader.split(',').find(s => s.includes('rel="next"'));
                if (nextLink) {
                    nextUrl = nextLink.match(/<(.+)>/)[1];
                }
            }
            isFirstPage = false;

        } catch (error) {
            if (error.response && error.response.status === 403) {
                // 处理Rate Limit错误
                const resetTime = error.response.headers['x-ratelimit-reset'];
                const remaining = error.response.headers['x-ratelimit-remaining'];

                if (resetTime) {
                    const resetDate = new Date(parseInt(resetTime) * 1000);
                    const now = new Date();
                    const waitTime = Math.max(0, resetDate.getTime() - now.getTime() + 5000); // 额外等待5秒
                    const waitSeconds = Math.ceil(waitTime / 1000);

                    console.warn(`Rate limit exceeded. Remaining: ${remaining || 0}. Waiting ${waitSeconds} seconds until ${resetDate.toISOString()}...`);
                    await delay(waitTime);

                    // 重试当前请求
                    console.log(`Retrying request to ${nextUrl}...`);
                    continue; // 重新执行当前循环
                } else {
                    // 如果没有reset时间，等待60秒后重试
                    console.warn(`Rate limit exceeded (no reset time). Waiting 60 seconds...`);
                    await delay(60000);
                    console.log(`Retrying request to ${nextUrl}...`);
                    continue; // 重新执行当前循环
                }
            }

            // 其他错误直接抛出
            console.error(`GitHub REST API Error on ${nextUrl}:`, error.response ? error.response.data : error.message);
            throw new Error(`GitHub API request failed for ${nextUrl}: ${error.message}`);
        }
    }

    // 返回一个与原始Search API结构相似的对象，方便后续处理
    return {
        total_count: totalCountFromApi,
        items: allItems
    };
}

// --- Git Commit Statistics Service ---

/**
 * Clones or pulls a repository and returns the path.
 */
async function cloneOrPullRepo(repoName) {
    const repoPath = path.join(REPO_STORAGE_PATH, repoName);
    const repoUrl = `https://${GITHUB_TOKEN}@github.com/${ORG_NAME}/${repoName}.git`;

    try {
        // 检查仓库目录是否存在
        const repoExists = await fs.access(repoPath).then(() => true).catch(() => false);

        if (repoExists) {
            // 仓库存在，尝试 pull
            try {
                // 先检查是否是有效的 git 仓库
                await execPromise(`git -C "${repoPath}" rev-parse --git-dir`, { timeout: 5000 });

                // 尝试 pull，如果失败可能是空仓库或分支问题
                try {
                    await execPromise(`git -C "${repoPath}" pull --ff-only`, { timeout: 60000 });
                } catch (pullError) {
                    // 如果 pull 失败，检查是否是空仓库或分支问题
                    const branchCheck = await execPromise(`git -C "${repoPath}" branch -r`, { timeout: 5000 }).catch(() => null);
                    if (!branchCheck || !branchCheck.stdout.trim()) {
                        console.warn(`${repoName}: 仓库为空或没有远程分支，跳过`);
                        // 返回路径但标记为无效
                        return repoPath;
                    }
                    // 尝试 fetch 然后 pull
                    console.warn(`${repoName}: Pull failed, trying fetch...`);
                    await execPromise(`git -C "${repoPath}" fetch origin`, { timeout: 60000 });
                    await execPromise(`git -C "${repoPath}" pull --ff-only`, { timeout: 60000 });
                }
            } catch (gitError) {
                // 如果不是有效的 git 仓库，删除并重新克隆
                console.warn(`${repoName}: not availabe, trying re-clone...`);
                await fs.rm(repoPath, { recursive: true, force: true });
                await execPromise(`git clone ${repoUrl} ${repoPath}`, { timeout: 120000 });
            }
        } else {
            // 仓库不存在，克隆
            console.log(`Cloning repo: ${repoName}`);
            try {
                await execPromise(`git clone ${repoUrl} ${repoPath}`, { timeout: 120000 });
            } catch (cloneError) {
                // 克隆失败可能是仓库不存在或为空
                console.error(`${repoName}: cloning failed: ${cloneError.message}`);
                // 创建一个空目录，后续 git log 会返回空结果
                await fs.mkdir(repoPath, { recursive: true });
                return repoPath;
            }
        }
    } catch (error) {
        console.error(`${repoName}: operate failed: ${error.message}`);
        // 确保目录存在，即使 git 操作失败
        await fs.mkdir(repoPath, { recursive: true }).catch(() => { });
        return repoPath;
    }

    return repoPath;
}

/**
 * Gets commit stats for a repository within a 24-hour window using git log.
 */
async function getCommitStats(repoName, targetDate) {
    const repoPath = await cloneOrPullRepo(repoName);

    const startDate = new Date(targetDate);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(targetDate);
    endDate.setDate(endDate.getDate() + 1);
    endDate.setHours(0, 0, 0, 0);

    // 使用我们之前修复过的、时区正确的 formatDate 函数
    const endISO = formatDate(endDate);
    const startISO = formatDate(startDate);

    const command = `git -C "${repoPath}" log --since="${startISO}" --until="${endISO}" --pretty=format:"COMMIT_SEPARATOR%an" --numstat`;

    try {
        const { stdout } = await execPromise(command, { maxBuffer: 1024 * 1024 * 10 });
        if (!stdout.trim()) {
            return { new_commits: 0, lines_added: 0, lines_deleted: 0, committers: new Set() };
        }

        const lines = stdout.trim().split('\n');

        let newCommits = 0;
        let linesAdded = 0;
        let linesDeleted = 0;
        const committers = new Set();
        
        // --- BUG FIX: 使用更健壮的解析逻辑 ---
        for (const line of lines) {
            if (line.startsWith('COMMIT_SEPARATOR')) {
                // 这是一个新的 commit，我们提取作者名
                newCommits++;
                const author = line.substring('COMMIT_SEPARATOR'.length).trim();
                if (author) {
                    committers.add(author);
                }
            } else {
                // 这是一个潜在的 numstat 行，我们需要严格验证它
                const parts = line.split('\t');
                
                // 验证：必须有3个部分，且前两个部分必须是数字或'-'
                if (parts.length === 3) {
                    const isInsertionsValid = !isNaN(parseInt(parts[0], 10)) || parts[0] === '-';
                    const isDeletionsValid = !isNaN(parseInt(parts[1], 10)) || parts[1] === '-';

                    if (isInsertionsValid && isDeletionsValid) {
                        // 确认这是一个合法的 numstat 行，再进行解析
                        const insertions = parseInt(parts[0], 10);
                        const deletions = parseInt(parts[1], 10);

                        if (!isNaN(insertions)) {
                            linesAdded += insertions;
                        }
                        if (!isNaN(deletions)) {
                            linesDeleted += deletions;
                        }
                    }
                    // 如果验证失败，我们会静默地忽略这一行，因为它不是我们想要的 numstat 数据
                }
            }
        }

        return {
            new_commits: newCommits,
            lines_added: linesAdded,
            lines_deleted: linesDeleted,
            committers: committers,
        };

    } catch (error) {
        console.error(`Git command failed for ${repoName}:`, error.message);
        return { new_commits: 0, lines_added: 0, lines_deleted: 0, committers: new Set() };
    }
}

// --- Data Ingestion Service (Cron Job & Backfill) ---

/**
 * [PIPELINE 1] Fetches ONLY commit stats via Git and stores them.
 * This process is completely independent of the API fetching process.
 */
async function fetchAndStoreRepoCommitStats(repoId, repoName, targetDate) {
    const targetDateStr = formatDate(targetDate);
    let commitStats;

    try {
        // This is the only fallible operation in this pipeline
        commitStats = await getCommitStats(repoName, targetDate);
        console.log(`[Git Pipeline] ${repoName}@${targetDateStr}: 采集到 commits=${commitStats.new_commits}, lines=+${commitStats.lines_added}/-${commitStats.lines_deleted}, committers=${commitStats.committers.size}`);
    } catch (error) {
        console.error(`[Git Pipeline] Failed to get commit stats for ${repoName}. Storing zero values. Error: ${error.message}`);
        // If git log fails, we ensure zero values are stored for these specific fields.
        commitStats = { new_commits: 0, lines_added: 0, lines_deleted: 0, committers: new Set() };
    }

    try {
        // Use ON CONFLICT to insert a new row or update an existing one.
        // This makes the process idempotent and safe for parallel execution.
        const result = await pool.query(
            `INSERT INTO repo_snapshots (repo_id, snapshot_date, new_commits, lines_added, lines_deleted)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (repo_id, snapshot_date) DO UPDATE
             SET new_commits = EXCLUDED.new_commits,
                 lines_added = EXCLUDED.lines_added,
                 lines_deleted = EXCLUDED.lines_deleted,
                 created_at = NOW()
             RETURNING id`,
            [repoId, targetDateStr, commitStats.new_commits, commitStats.lines_added, commitStats.lines_deleted]
        );
        console.log(`[Git Pipeline] ${repoName}@${targetDateStr}: ✅ 已存储到数据库 (id=${result.rows[0].id})`);
    } catch (error) {
        console.error(`[Git Pipeline] Error storing commit data for repo ${repoName}:`, error.message);
        // We throw here because a DB error is more critical.
        throw error;
    }
}

/**
 * [PIPELINE 2] Fetches ONLY API-related stats (PRs, Issues) and stores them.
 * This process is completely independent of the Git stats process.
 */
async function fetchAndStoreRepoApiStats(repoId, repoName, targetDate) {
    const targetDateStr = formatDate(targetDate);
    let apiMetrics;
    console.log(`[API Pipeline] Starting to fetch API stats for: ${repoName}`);

    try {
        // This block contains all fallible API calls.
        const targetDateStr = formatDate(targetDate); // 格式如 "2025-11-08"
        const repoQuery = `repo:${ORG_NAME}/${repoName}`;

        // 直接在查询中使用 YYYY-MM-DD 格式，GitHub Search API 会自动将其识别为全天
        const createdPrs = await githubRest('/search/issues', { q: `${repoQuery} is:pr created:${targetDateStr}`, per_page: 100 });
        const createdIssues = await githubRest('/search/issues', { q: `${repoQuery} is:issue -is:pr created:${targetDateStr}`, per_page: 100 });
        const closedPrs = await githubRest('/search/issues', { q: `${repoQuery} is:pr is:closed closed:${targetDateStr}`, per_page: 100 });
        const closedIssues = await githubRest('/search/issues', { q: `${repoQuery} is:issue -is:pr is:closed closed:${targetDateStr}`, per_page: 100 });

        const activeContributors = new Set();
        [...createdPrs.items, ...createdIssues.items, ...closedPrs.items, ...closedIssues.items].forEach(item => activeContributors.add(item.user.login));

        apiMetrics = {
            new_prs: createdPrs.total_count,
            closed_merged_prs: closedPrs.total_count,
            new_issues: createdIssues.total_count,
            closed_issues: closedIssues.total_count,
            active_contributors: activeContributors.size,
        };

        console.log(`[API Pipeline] ${repoName}@${targetDateStr}: 采集到 PRs=${apiMetrics.new_prs} (closed=${apiMetrics.closed_merged_prs}), Issues=${apiMetrics.new_issues} (closed=${apiMetrics.closed_issues}), contributors=${apiMetrics.active_contributors}`);
    } catch (error) {
        console.error(`[API Pipeline] Failed to fetch API metrics for ${repoName}. Storing zero values. Error: ${error.message}`);
        apiMetrics = { new_prs: 0, closed_merged_prs: 0, new_issues: 0, closed_issues: 0, active_contributors: 0 };
    }

    try {
        // This query will insert or update, safely merging with data from the commit pipeline.
        const result = await pool.query(
            `INSERT INTO repo_snapshots (repo_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (repo_id, snapshot_date) DO UPDATE
             SET new_prs = EXCLUDED.new_prs,
                 closed_merged_prs = EXCLUDED.closed_merged_prs,
                 new_issues = EXCLUDED.new_issues,
                 closed_issues = EXCLUDED.closed_issues,
                 active_contributors = EXCLUDED.active_contributors,
                 created_at = NOW()
             RETURNING id`,
            [repoId, targetDateStr, apiMetrics.new_prs, apiMetrics.closed_merged_prs, apiMetrics.new_issues, apiMetrics.closed_issues, apiMetrics.active_contributors]
        );
        console.log(`[API Pipeline] ${repoName}@${targetDateStr}: saved in database (id=${result.rows[0].id})`);
    } catch (error) {
        console.error(`[API Pipeline] Error storing API data for repo ${repoName}:`, error.message);
        throw error;
    }
}

/**
 * Runs an array of promise-returning functions with limited concurrency.
 * @param {Array<() => Promise<any>>} tasks An array of functions that each return a Promise.
 * @param {number} concurrency The maximum number of tasks to run at once.
 * @returns {Promise<any[]>} A promise that resolves with an array of all task results.
 */
async function runPromisesWithConcurrency(tasks, concurrency) {
    const results = [];
    let currentIndex = 0;

    // The worker function that processes tasks one by one from the tasks array.
    const worker = async () => {
        while (currentIndex < tasks.length) {
            const taskIndex = currentIndex++;
            const task = tasks[taskIndex];
            try {
                results[taskIndex] = await task();
            } catch (error) {
                // Store error to review later if needed, or handle it
                results[taskIndex] = error;
                console.error(`Task at index ${taskIndex} failed:`, error.message);
            }
        }
    };

    // Create and start the workers.
    const workers = Array(concurrency).fill(null).map(() => worker());

    // Wait for all workers to complete.
    await Promise.all(workers);

    return results;
}

/**
 * Aggregates repo snapshots into SIG snapshots.
 */
async function aggregateSigSnapshot(sigId, targetDate) {
    const targetDateStr = formatDate(targetDate);

    // 获取SIG名称
    const sigResult = await pool.query('SELECT name FROM special_interest_groups WHERE id = $1', [sigId]);
    const sigName = sigResult.rows[0]?.name || `SIG-${sigId}`;

    // 1. Aggregate from repo_snapshots
    const aggregateResult = await pool.query(
        `SELECT COALESCE(SUM(rs.new_prs), 0) as new_prs,
                COALESCE(SUM(rs.closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(rs.new_issues), 0) as new_issues,
                COALESCE(SUM(rs.closed_issues), 0) as closed_issues,
                COALESCE(SUM(rs.active_contributors), 0) as active_contributors,
                COALESCE(SUM(rs.new_commits), 0) as new_commits,
                COALESCE(SUM(rs.lines_added), 0) as lines_added,
                COALESCE(SUM(rs.lines_deleted), 0) as lines_deleted,
                COUNT(*) as repo_count
         FROM repo_snapshots rs
         JOIN repositories r ON rs.repo_id = r.id
         WHERE r.sig_id = $1 AND rs.snapshot_date = $2`,
        [sigId, targetDateStr]
    );

    const agg = aggregateResult.rows[0];

    // 2. Store SIG-level snapshot
    const sigMetrics = {
        new_prs: parseInt(agg.new_prs) || 0,
        closed_merged_prs: parseInt(agg.closed_merged_prs) || 0,
        new_issues: parseInt(agg.new_issues) || 0,
        closed_issues: parseInt(agg.closed_issues) || 0,
        active_contributors: parseInt(agg.active_contributors) || 0,
        new_commits: parseInt(agg.new_commits) || 0,
        lines_added: parseInt(agg.lines_added) || 0,
        lines_deleted: parseInt(agg.lines_deleted) || 0,
    };

    console.log(`[聚合] ${sigName}@${targetDateStr}: 从 ${agg.repo_count} 个仓库聚合得到 commits=${sigMetrics.new_commits}, PRs=${sigMetrics.new_prs}, Issues=${sigMetrics.new_issues}, lines=+${sigMetrics.lines_added}/-${sigMetrics.lines_deleted}`);

    const result = await pool.query(
        `INSERT INTO sig_snapshots (sig_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_commits, lines_added, lines_deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (sig_id, snapshot_date) DO UPDATE
         SET new_prs = EXCLUDED.new_prs,
             closed_merged_prs = EXCLUDED.closed_merged_prs,
             new_issues = EXCLUDED.new_issues,
             closed_issues = EXCLUDED.closed_issues,
             active_contributors = EXCLUDED.active_contributors,
             new_commits = EXCLUDED.new_commits,
             lines_added = EXCLUDED.lines_added,
             lines_deleted = EXCLUDED.lines_deleted,
             created_at = NOW()
         RETURNING id`,
        [sigId, targetDateStr, sigMetrics.new_prs, sigMetrics.closed_merged_prs, sigMetrics.new_issues, sigMetrics.closed_issues, sigMetrics.active_contributors, sigMetrics.new_commits, sigMetrics.lines_added, sigMetrics.lines_deleted]
    );
    console.log(`[聚合] ${sigName}@${targetDateStr}: ✅ 已存储SIG快照 (id=${result.rows[0].id})`);
    return sigMetrics;
}

/**
 * 主动刷新 Redis 缓存
 */
async function refreshCache() {
    console.log('--- Refreshing Redis Cache ---');
    try {
        const org = await getMonitoredOrg();
        if (!org) {
            console.log('Organization not found. Skipping cache refresh.');
            return;
        }

        // 刷新组织时间序列数据（30天）
        const range = '30d';
        const days = 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = formatDate(startDate);

        const dataResult = await pool.query(
            `SELECT 
                snapshot_date, 
                new_prs, 
                closed_merged_prs, 
                new_issues, 
                closed_issues, 
                active_contributors, 
                new_repos,
                new_commits,
                lines_added,
                lines_deleted
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [org.id, startDateStr]
        );

        const timeseriesData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
            new_repos: row.new_repos,
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted,
        }));

        const cacheKey = `org:${ORG_NAME}:range:${range}`;
        const cacheTTL = 60 * 10; // 10 minutes
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(timeseriesData));
        console.log(`Cached organization timeseries data (${timeseriesData.length} records)`);

        // 刷新所有 SIG 的缓存
        const sigsResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE org_id = $1', [org.id]);

        for (const sig of sigsResult.rows) {
            // 刷新 SIG commit 数据
            const commitDataResult = await pool.query(
                `SELECT snapshot_date, new_commits, lines_added, lines_deleted
                 FROM sig_snapshots
                 WHERE sig_id = $1 AND snapshot_date >= $2
                 ORDER BY snapshot_date ASC`,
                [sig.id, startDateStr]
            );

            const commitData = commitDataResult.rows.map(row => ({
                date: formatDate(row.snapshot_date),
                new_commits: row.new_commits,
                lines_added: row.lines_added,
                lines_deleted: row.lines_deleted,
            }));

            const commitCacheKey = `sig:${sig.id}:commits:range:${range}`;
            await redisClient.setEx(commitCacheKey, cacheTTL, JSON.stringify(commitData));

            // 刷新 SIG API 数据
            const apiDataResult = await pool.query(
                `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors
                 FROM sig_snapshots
                 WHERE sig_id = $1 AND snapshot_date >= $2
                 ORDER BY snapshot_date ASC`,
                [sig.id, startDateStr]
            );

            const apiData = apiDataResult.rows.map(row => ({
                date: formatDate(row.snapshot_date),
                new_prs: row.new_prs,
                closed_merged_prs: row.closed_merged_prs,
                new_issues: row.new_issues,
                closed_issues: row.closed_issues,
                active_contributors: row.active_contributors,
            }));

            const apiCacheKey = `sig:${sig.id}:api:range:${range}`;
            await redisClient.setEx(apiCacheKey, cacheTTL, JSON.stringify(apiData));
        }

        console.log(`Cached ${sigsResult.rows.length} SIG timeseries data`);
        console.log('--- Cache Refresh Complete ---');

    } catch (error) {
        console.error('Failed to refresh cache:', error.message);
    }
}

/**
 * Runs the daily ingestion job for the current day using decoupled pipelines.
 */
async function runDailyIngestionJob() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1); 
    yesterday.setHours(0, 0, 0, 0);

    const targetDate = yesterday;
    const targetDateStr = formatDate(targetDate);

    console.log(`--- Starting Daily Data Ingestion Job for date: ${targetDateStr} ---`);
    try {
        const orgsResult = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
        const org = orgsResult.rows[0];
        if (!org) {
            console.log('Monitored organization not found. Skipping job.');
            return;
        }

        const reposResult = await pool.query('SELECT id, name, sig_id FROM repositories WHERE org_id = $1', [org.id]);
        const repositories = reposResult.rows;

        if (repositories.length === 0) {
            console.log('No repositories configured to monitor. Skipping job.');
            return;
        }

        // Git操作可以并发更高（不受API限流影响），API操作并发较低（避免限流）
        const gitConcurrencyLimit = 5; // Git操作并发5个
        const apiConcurrencyLimit = 3; // API操作并发3个（每分钟30次，3个并发×2秒间隔=6秒，安全）
        console.log(`Processing ${repositories.length} repos with Git concurrency: ${gitConcurrencyLimit}, API concurrency: ${apiConcurrencyLimit}`);

        // --- PIPELINE 1: Process all Git-based stats ---
        console.log('\n--- [Phase 1/3] Starting Git Commit Stats Ingestion ---');
        const commitTasks = repositories.map(repo =>
            () => fetchAndStoreRepoCommitStats(repo.id, repo.name, targetDate)
        );
        await runPromisesWithConcurrency(commitTasks, gitConcurrencyLimit);
        console.log('--- [Phase 1/3] Git Commit Stats Ingestion Finished ---');

        // --- PIPELINE 2: Process all API-based stats ---
        console.log('\n--- [Phase 2/3] Starting GitHub API Stats Ingestion ---');
        const apiTasks = repositories.map(repo =>
            () => fetchAndStoreRepoApiStats(repo.id, repo.name, targetDate)
        );
        await runPromisesWithConcurrency(apiTasks, apiConcurrencyLimit);
        console.log('--- [Phase 2/3] GitHub API Stats Ingestion Finished ---');

        // --- FINAL PHASE: Aggregate all data ---
        console.log('\n--- [Phase 3/3] Starting Data Aggregation ---');
        // The aggregation logic remains the same, as it reads from the now-populated table.
        const sigsResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE org_id = $1', [org.id]);
        const sigs = sigsResult.rows;

        const sigAggregationPromises = sigs.map(sig => aggregateSigSnapshot(sig.id, targetDate));
        await Promise.all(sigAggregationPromises);
        console.log(`Successfully stored all ${sigs.length} SIG snapshots for ${targetDateStr}.`);

        // 4. Aggregate SIG Snapshots into Organization Snapshot
        const orgAggregationResult = await pool.query(
            `SELECT COALESCE(SUM(ss.new_prs), 0) as new_prs,
            COALESCE(SUM(ss.closed_merged_prs), 0) as closed_merged_prs,
            COALESCE(SUM(ss.new_issues), 0) as new_issues,
            COALESCE(SUM(ss.closed_issues), 0) as closed_issues,
            COALESCE(SUM(ss.active_contributors), 0) as active_contributors,
            COALESCE(SUM(ss.new_commits), 0) as new_commits,
            COALESCE(SUM(ss.lines_added), 0) as lines_added,
            COALESCE(SUM(ss.lines_deleted), 0) as lines_deleted
     FROM sig_snapshots ss
     JOIN special_interest_groups sig ON ss.sig_id = sig.id
     JOIN organizations org ON sig.org_id = org.id
     WHERE org.name = $1 AND ss.snapshot_date = $2`,
            [ORG_NAME, targetDateStr] // <-- 查询条件更精确
        );

        const orgAgg = orgAggregationResult.rows[0];
        const orgMetrics = {
            new_prs: parseInt(orgAgg.new_prs) || 0,
            closed_merged_prs: parseInt(orgAgg.closed_merged_prs) || 0,
            new_issues: parseInt(orgAgg.new_issues) || 0,
            closed_issues: parseInt(orgAgg.closed_issues) || 0,
            active_contributors: parseInt(orgAgg.active_contributors) || 0,
            new_commits: parseInt(orgAgg.new_commits) || 0,
            lines_added: parseInt(orgAgg.lines_added) || 0,
            lines_deleted: parseInt(orgAgg.lines_deleted) || 0,
            new_repos: 0,
        };

        console.log(`[aggregation] organization@${targetDateStr}: commits=${orgMetrics.new_commits}, PRs=${orgMetrics.new_prs} (合并=${orgMetrics.closed_merged_prs}), Issues=${orgMetrics.new_issues} (关闭=${orgMetrics.closed_issues}), contributors=${orgMetrics.active_contributors}, lines=+${orgMetrics.lines_added}/-${orgMetrics.lines_deleted}`);

        const result = await pool.query(
            `INSERT INTO activity_snapshots (org_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos, new_commits, lines_added, lines_deleted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (org_id, snapshot_date) DO UPDATE
     SET new_prs = EXCLUDED.new_prs,
         closed_merged_prs = EXCLUDED.closed_merged_prs,
         new_issues = EXCLUDED.new_issues,
         closed_issues = EXCLUDED.closed_issues,
         active_contributors = EXCLUDED.active_contributors,
         new_repos = EXCLUDED.new_repos,
         new_commits = EXCLUDED.new_commits,
         lines_added = EXCLUDED.lines_added,
         lines_deleted = EXCLUDED.lines_deleted,
         created_at = NOW()
     RETURNING id`,
            [org.id, targetDateStr, orgMetrics.new_prs, orgMetrics.closed_merged_prs, orgMetrics.new_issues, orgMetrics.closed_issues, orgMetrics.active_contributors, orgMetrics.new_repos, orgMetrics.new_commits, orgMetrics.lines_added, orgMetrics.lines_deleted]
        );
        console.log(`[aggregation] organization@${targetDateStr}: saved snapshot (id=${result.rows[0].id})`);
        console.log(`Successfully stored organization snapshot for ${ORG_NAME} on ${targetDateStr}.`);

        console.log('--- Daily Data Ingestion Job Finished Successfully ---');

        // 主动刷新缓存
        await refreshCache();

    } catch (error) {
        console.error('CRON Job Failed:', error.message);
    }
}

/**
 * Runs a backfill job for the last N days using decoupled pipelines.
 */
async function runBackfillJob(days = 7) {
    console.log(`--- Starting Backfill Job for the last ${days} days ---`);
    try {
        const orgsResult = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
        const org = orgsResult.rows[0];
        if (!org) {
            console.log('Monitored organization not found. Skipping backfill.');
            return;
        }

        const reposResult = await pool.query('SELECT id, name, sig_id FROM repositories WHERE org_id = $1', [org.id]);
        const repositories = reposResult.rows;

        if (repositories.length === 0) {
            console.log('No repositories configured to monitor. Skipping backfill.');
            return;
        }

        const sigsResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE org_id = $1', [org.id]);
        const sigs = sigsResult.rows;

        // Get today's date (midnight)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Calculate date range
        const startDate = new Date(today);
        startDate.setDate(today.getDate() - days);
        const startDateStr = formatDate(startDate);
        const todayStr = formatDate(today);

        console.log(`Checking for existing data between ${startDateStr} and ${todayStr}...`);
        const existingSnapshotsResult = await pool.query(
            `SELECT DISTINCT snapshot_date
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2 AND snapshot_date <= $3`,
            [org.id, startDateStr, todayStr]
        );

        // 将日期字符串存入 Set 以便快速查找
        const existingDates = new Set(
            existingSnapshotsResult.rows.map(row => formatDate(new Date(row.snapshot_date)))
        );
        
        if(existingDates.size > 0) {
             console.log(`Found ${existingDates.size} completed days. Will skip them.`);
        } else {
             console.log('No existing data found in the range. Will backfill all days.');
        }

        console.log(`\ndates: ${startDateStr} to ${todayStr}`);
        console.log(`repo nums: ${repositories.length}`);
        console.log(`SIG nums: ${sigs.length}\n`);

        // Loop from the oldest day (30 days ago) to yesterday to backfill data
        for (let i = days; i >= 1; i--) {
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i);
            const targetDateStr = formatDate(targetDate);

            if (existingDates.has(targetDateStr)) {
                console.log(`[Skip] Data for ${targetDateStr} already exists.`);
                continue; // 跳到下一天
            }

            console.log(`\n--- Backfilling data for date: ${targetDateStr} ---`);
            // Git操作可以并发更高，API操作并发较低
            const gitConcurrencyLimit = 5;
            const apiConcurrencyLimit = 3;

            // --- PIPELINE 1: Process all Git-based stats for the target date ---
            console.log(`[${targetDateStr}] [Phase 1/3] Starting Git Commit Stats Backfill...`);
            const commitTasks = repositories.map(repo =>
                () => fetchAndStoreRepoCommitStats(repo.id, repo.name, targetDate)
            );
            await runPromisesWithConcurrency(commitTasks, gitConcurrencyLimit);
            console.log(`[${targetDateStr}] [Phase 1/3] Git Commit Stats Backfill Finished.`);

            // --- PIPELINE 2: Process all API-based stats for the target date ---
            console.log(`[${targetDateStr}] [Phase 2/3] Starting GitHub API Stats Backfill...`);
            const apiTasks = repositories.map(repo =>
                () => fetchAndStoreRepoApiStats(repo.id, repo.name, targetDate)
            );
            await runPromisesWithConcurrency(apiTasks, apiConcurrencyLimit);
            console.log(`[${targetDateStr}] [Phase 2/3] GitHub API Stats Backfill Finished.`);

            // --- FINAL PHASE: Aggregate all data for the target date ---
            console.log(`[${targetDateStr}] [Phase 3/3] Starting Data Aggregation...`);
            // SIG Aggregation
            const sigAggregationPromises = sigs.map(sig => aggregateSigSnapshot(sig.id, targetDate));
            await Promise.all(sigAggregationPromises);

            // Organization Aggregation (using your existing logic)
            const orgAggregationResult = await pool.query(
                `SELECT COALESCE(SUM(ss.new_prs), 0) as new_prs,
                        COALESCE(SUM(ss.closed_merged_prs), 0) as closed_merged_prs,
                        COALESCE(SUM(ss.new_issues), 0) as new_issues,
                        COALESCE(SUM(ss.closed_issues), 0) as closed_issues,
                        COALESCE(SUM(ss.active_contributors), 0) as active_contributors,
                        COALESCE(SUM(ss.new_commits), 0) as new_commits,
                        COALESCE(SUM(ss.lines_added), 0) as lines_added,
                        COALESCE(SUM(ss.lines_deleted), 0) as lines_deleted
                 FROM sig_snapshots ss
                 JOIN special_interest_groups sig ON ss.sig_id = sig.id
                 WHERE sig.org_id = $1 AND ss.snapshot_date = $2`,
                [org.id, targetDateStr]
            );

            const orgAgg = orgAggregationResult.rows[0];
            const orgMetrics = {
                new_prs: parseInt(orgAgg.new_prs) || 0,
                closed_merged_prs: parseInt(orgAgg.closed_merged_prs) || 0,
                new_issues: parseInt(orgAgg.new_issues) || 0,
                closed_issues: parseInt(orgAgg.closed_issues) || 0,
                active_contributors: parseInt(orgAgg.active_contributors) || 0,
                new_commits: parseInt(orgAgg.new_commits) || 0,
                lines_added: parseInt(orgAgg.lines_added) || 0,
                lines_deleted: parseInt(orgAgg.lines_deleted) || 0,
                new_repos: 0,
            };

            console.log(`[aggregation] organisation@${targetDateStr}: commits=${orgMetrics.new_commits}, PRs=${orgMetrics.new_prs} (merged=${orgMetrics.closed_merged_prs}), Issues=${orgMetrics.new_issues} (closed=${orgMetrics.closed_issues}), contributors=${orgMetrics.active_contributors}, lines=+${orgMetrics.lines_added}/-${orgMetrics.lines_deleted}`);

            const result = await pool.query(
                `INSERT INTO activity_snapshots (org_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos, new_commits, lines_added, lines_deleted)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 ON CONFLICT (org_id, snapshot_date) DO UPDATE
                 SET new_prs = EXCLUDED.new_prs,
                     closed_merged_prs = EXCLUDED.closed_merged_prs,
                     new_issues = EXCLUDED.new_issues,
                     closed_issues = EXCLUDED.closed_issues,
                     active_contributors = EXCLUDED.active_contributors,
                     new_repos = EXCLUDED.new_repos,
                     new_commits = EXCLUDED.new_commits,
                     lines_added = EXCLUDED.lines_added,
                     lines_deleted = EXCLUDED.lines_deleted,
                     created_at = NOW()
                 RETURNING id`,
                [org.id, targetDateStr, orgMetrics.new_prs, orgMetrics.closed_merged_prs, orgMetrics.new_issues, orgMetrics.closed_issues, orgMetrics.active_contributors, orgMetrics.new_repos, orgMetrics.new_commits, orgMetrics.lines_added, orgMetrics.lines_deleted]
            );
            console.log(`[aggregation] organisation@${targetDateStr}: snapshot saved (id=${result.rows[0].id})`);
            console.log(`[${targetDateStr}] [Phase 3/3] Data Aggregation Done.`);
        }

        console.log('\n--- Backfill Job Finished Successfully ---');

        // 主动刷新缓存
        await refreshCache();

    } catch (error) {
        console.error('Backfill Job Failed:', error.message);
    }
}

// Schedule the job to run once every 24 hours (e.g., at 00:00 UTC)
// cron.schedule('0 0 * * *', runDailyIngestionJob); // Daily at midnight
cron.schedule('0 */6 * * *', runDailyIngestionJob); // Every 6 hours for testing

// --- API Routes ---

// Helper function for security check (now simplified for single org)
async function getMonitoredOrg() {
    const orgResult = await pool.query("SELECT id, name FROM organizations WHERE name = $1", [ORG_NAME]);
    return orgResult.rows[0];
}

// GET /api/v1/organization/sigs - New route to get all monitored SIGs
app.get('/api/v1/organization/sigs', async (req, res) => {
    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        const sigsResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE org_id = $1 ORDER BY name', [org.id]);
        res.json(sigsResult.rows);
    } catch (error) {
        console.error('Error fetching SIGs:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organization/summary - [新增] 提供组织在指定时间范围内的汇总数据
app.get('/api/v1/organization/summary', async (req, res) => {
    // 默认30天，允许通过查询参数更改，例如 /summary?range=7d
    const range = req.query.range || '30d'; 
    const cacheKey = `org:${ORG_NAME}:summary:range:${range}`;
    const cacheTTL = 60 * 10; // 缓存10分钟

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        // 1. 检查缓存
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for summary: ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for summary: ${cacheKey}. Querying DB...`);

        // 2. 计算日期范围
        let days;
        if (range.endsWith('d')) {
            days = parseInt(range.slice(0, -1), 10);
        } else {
            days = 30; // 默认回退
        }

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = formatDate(startDate); // 使用修复后的时区安全函数

        // 3. 从数据库查询并聚合数据
        // 注意：我们不再SUM(active_contributors)，因为它会重复计算
        const summaryResult = await pool.query(
            `SELECT 
                COALESCE(SUM(new_prs), 0) as new_prs,
                COALESCE(SUM(closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(new_issues), 0) as new_issues,
                COALESCE(SUM(new_commits), 0) as new_commits,
                COALESCE(SUM(lines_added), 0) as lines_added,
                COALESCE(SUM(lines_deleted), 0) as lines_deleted,
                -- 为了调试和验证，可以返回统计了多少天的数据
                COUNT(*) as days_counted 
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2`,
            [org.id, startDateStr]
        );

        // 将 bigint (string) 转换为 number
        const summaryData = {
            new_prs: parseInt(summaryResult.rows[0].new_prs, 10),
            closed_merged_prs: parseInt(summaryResult.rows[0].closed_merged_prs, 10),
            new_issues: parseInt(summaryResult.rows[0].new_issues, 10),
            new_commits: parseInt(summaryResult.rows[0].new_commits, 10),
            lines_added: parseInt(summaryResult.rows[0].lines_added, 10),
            lines_deleted: parseInt(summaryResult.rows[0].lines_deleted, 10),
            days_counted: parseInt(summaryResult.rows[0].days_counted, 10),
            range_days: days, // 在响应中包含请求的范围
        };
        
        // 4. 存入缓存并返回
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(summaryData));
        console.log(`Summary data stored in cache for ${cacheKey}.`);

        res.json(summaryData);

    } catch (error) {
        console.error(`Error fetching summary data for organization:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/timeseries - New route for SIG timeseries
app.get('/api/v1/sig/:sigId/timeseries', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d'; // Default to 30 days
    const cacheKey = `sig:${sigId}:range:${range}`;
    const cacheTTL = 60 * 10; // 10 minutes

    try {
        // 1. Check if SIG is monitored
        const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }
        const sigName = sigResult.rows[0].name;

        // 2. Caching Logic: Check Redis
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        // 3. Query Database
        let days;
        if (range.endsWith('d')) {
            days = parseInt(range.slice(0, -1), 10);
        } else {
            days = 30; // Fallback
        }

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = formatDate(startDate);

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_commits, lines_added, lines_deleted
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [sigId, startDateStr]
        );

        const timeseriesData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted,
        }));

        // 4. Store in Redis and return
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(timeseriesData));
        console.log(`Data stored in cache for ${cacheKey}.`);

        res.json(timeseriesData);

    } catch (error) {
        console.error(`Error fetching timeseries data for SIG ${sigName}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/timeseries/commits - 只返回Commit相关数据
app.get('/api/v1/sig/:sigId/timeseries/commits', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d';
    const cacheKey = `sig:${sigId}:commits:range:${range}`;
    const cacheTTL = 60 * 10; // 10 minutes

    try {
        const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }

        // 检查缓存
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.json(JSON.parse(cachedData));
        }

        let days = parseInt(range.slice(0, -1), 10) || 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - (days - 1));
        const startDateStr = formatDate(startDate);

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_commits, lines_added, lines_deleted
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [sigId, startDateStr]
        );

        const responseData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted,
        }));

        // 存入缓存
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error(`Error fetching commit timeseries for SIG ${sigId}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/timeseries/api - 只返回API相关数据
app.get('/api/v1/sig/:sigId/timeseries/api', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d';
    const cacheKey = `sig:${sigId}:api:range:${range}`;
    const cacheTTL = 60 * 10; // 10 minutes

    try {
        const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }

        // 检查缓存
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.json(JSON.parse(cachedData));
        }

        let days = parseInt(range.slice(0, -1), 10) || 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - (days - 1));
        const startDateStr = formatDate(startDate);

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [sigId, startDateStr]
        );

        const responseData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
        }));

        // 存入缓存
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error(`Error fetching API timeseries for SIG ${sigId}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organization/timeseries - Now for the single monitored org
app.get('/api/v1/organization/timeseries', async (req, res) => {
    const range = req.query.range || '30d'; // Default to 30 days
    const cacheKey = `org:${ORG_NAME}:range:${range}`;
    const cacheTTL = 60 * 10; // 10 minutes

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        // 2. Caching Logic: Check Redis
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        // 3. Query Database
        let days;
        if (range.endsWith('d')) {
            days = parseInt(range.slice(0, -1), 10);
        } else {
            days = 30; // Fallback
        }

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = formatDate(startDate);

        const dataResult = await pool.query(
            `SELECT 
        snapshot_date, 
        new_prs, 
        closed_merged_prs, 
        new_issues, 
        closed_issues, 
        active_contributors, 
        new_repos,
        new_commits,
        lines_added,
        lines_deleted
     FROM activity_snapshots
     WHERE org_id = $1 AND snapshot_date::date >= $2::date
     ORDER BY snapshot_date ASC`,
            [org.id, startDateStr]
        );

        const timeseriesData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
            new_repos: row.new_repos,
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted,
        }));

        // 4. Store in Redis and return
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(timeseriesData));
        console.log(`Data stored in cache for ${cacheKey}.`);

        res.json(timeseriesData);

    } catch (error) {
        console.error(`Error fetching timeseries data for organization:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organization/latest-activity - Now for the single monitored org
app.get('/api/v1/organization/latest-activity', async (req, res) => {
    const { type } = req.query; // 'prs' or 'issues'

    // Parse pagination parameters
    const page = parseInt(req.query.page) || 1;
    const per_page = parseInt(req.query.per_page) || 10;

    // GitHub Search API limits per_page to 100
    const limit = Math.min(per_page, 100);

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        let query;
        if (type === 'prs') {
            // Search for open Pull Requests, sorted by creation date descending
            query = `org:${org.name} is:pr is:open sort:created-desc`;
        } else if (type === 'issues') {
            // Search for open Issues (excluding PRs), sorted by creation date descending
            query = `org:${org.name} is:issue is:open -is:pr sort:created-desc`;
        } else {
            return res.status(400).json({ error: 'Invalid activity type. Must be "prs" or "issues".' });
        }

        const searchResults = await githubRest('/search/issues', {
            q: query,
            per_page: limit,
            page: page,
        });

        const activities = searchResults.items.map(item => ({
            id: item.id,
            title: item.title,
            url: item.html_url,
            repo: item.repository_url.split('/').pop(),
            author: item.user.login,
            created_at: item.created_at,
            state: item.state,
        }));

        // Return the activities and the total count for pagination
        res.json({
            activities: activities,
            total_count: searchResults.total_count,
            page: page,
            per_page: limit,
        });

    } catch (error) {
        console.error(`Error fetching latest activity for organization:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/summary - 提供单个SIG在指定时间范围内的汇总数据
app.get('/api/v1/sig/:sigId/summary', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d'; // 默认30天
    const cacheKey = `sig:${sigId}:summary:range:${range}`;
    const cacheTTL = 60 * 10; // 缓存10分钟

    try {
        // 1. 验证 SIG 是否存在
        const sigResult = await pool.query('SELECT id FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }

        // 2. 检查缓存
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for SIG summary: ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for SIG summary: ${cacheKey}. Querying DB...`);

        // 3. 计算日期范围
        const days = parseInt(range.slice(0, -1), 10) || 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = formatDate(startDate);

        // 4. 从 sig_snapshots 表查询并聚合数据
        const summaryResult = await pool.query(
            `SELECT 
                COALESCE(SUM(new_prs), 0) as new_prs,
                COALESCE(SUM(closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(new_issues), 0) as new_issues,
                COALESCE(SUM(closed_issues), 0) as closed_issues,
                COALESCE(SUM(new_commits), 0) as new_commits,
                COALESCE(SUM(lines_added), 0) as lines_added,
                COALESCE(SUM(lines_deleted), 0) as lines_deleted,
                COUNT(*) as days_counted
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2`,
            [sigId, startDateStr]
        );
        
        // 转换数据格式
        const summaryData = {
            new_prs: parseInt(summaryResult.rows[0].new_prs, 10),
            closed_merged_prs: parseInt(summaryResult.rows[0].closed_merged_prs, 10),
            new_issues: parseInt(summaryResult.rows[0].new_issues, 10),
            closed_issues: parseInt(summaryResult.rows[0].closed_issues, 10),
            new_commits: parseInt(summaryResult.rows[0].new_commits, 10),
            lines_added: parseInt(summaryResult.rows[0].lines_added, 10),
            lines_deleted: parseInt(summaryResult.rows[0].lines_deleted, 10),
            days_counted: parseInt(summaryResult.rows[0].days_counted, 10),
            range_days: days,
        };

        // 5. 存入缓存并返回
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(summaryData));
        console.log(`SIG summary data stored in cache for ${cacheKey}.`);

        res.json(summaryData);

    } catch (error) {
        console.error(`Error fetching summary data for SIG ${sigId}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Server Start ---
app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // Ensure repo storage path exists
    try {
        await fs.mkdir(REPO_STORAGE_PATH, { recursive: true });
    } catch (e) {
        console.error('Error creating repo storage path:', e.message);
    }

    // Clear Redis cache on startup
    try {
        await redisClient.flushAll();
        console.log('Redis cache cleared on startup.');
    } catch (e) {
        console.error('Failed to clear Redis cache:', e.message);
    }

    // 直接从30天前开始采集到今天的数据
    try {
        const DAYS_TO_COLLECT = 30;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const startDate = new Date(today);
        startDate.setDate(today.getDate() - DAYS_TO_COLLECT);

        console.log('========================================');
        console.log('开始数据采集任务');
        console.log('========================================');
        console.log(`📅 采集范围: ${formatDate(startDate)} 到 ${formatDate(today)} (${DAYS_TO_COLLECT + 1} 天)`);
        console.log('========================================\n');

        await runBackfillJob(DAYS_TO_COLLECT);
    } catch (e) {
        console.error('Startup error:', e.message);
    }
});
