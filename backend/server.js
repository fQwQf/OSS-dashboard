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
const formatDate = (date) => date.toISOString().split('T')[0];

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

// --- Middleware ---
app.use(express.json());
// Allow CORS from the frontend development server (e.g., http://localhost:5173)
app.use(require('cors')({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: 'GET',
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

    while (nextUrl) {
        await delay(1000); // 增加延迟以更好地遵守Search API的速率限制 (30次/分钟)
        
        try {
            const response = await axios.get(nextUrl, {
                // 只在第一页请求时使用传入的params
                params: isFirstPage ? params : {}, 
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                }
            });

            // 如果数据结构是 { total_count, items: [...] } (来自Search API)
            if (Array.isArray(response.data.items)) {
                allItems = allItems.concat(response.data.items);
            } else if (Array.isArray(response.data)) { // 如果直接返回数组
                allItems = allItems.concat(response.data);
            }

            // 解析 'Link' 头来获取下一页的URL
            const linkHeader = response.headers.link;
            nextUrl = null; // 默认没有下一页
            if (linkHeader) {
                const nextLink = linkHeader.split(',').find(s => s.includes('rel="next"'));
                if (nextLink) {
                    nextUrl = nextLink.match(/<(.+)>/)[1];
                }
            }
            isFirstPage = false;

        } catch (error) {
            console.error(`GitHub REST API Error on ${nextUrl}:`, error.response ? error.response.data : error.message);
            if (error.response && error.response.status === 403 && error.response.data.message.includes('rate limit')) {
                // 等待一段时间后重试或直接抛出错误
                console.log("Rate limit exceeded. Waiting for 60 seconds before aborting...");
                await delay(60000); 
                // 在实际生产中，这里可能需要更复杂的重试逻辑
            }
            // 发生错误后停止分页
            throw new Error(`GitHub API request failed for ${nextUrl}: ${error.message}`);
        }
    }
    
    // 返回一个与原始Search API结构相似的对象，方便后续处理
    return {
        total_count: allItems.length,
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
        await fs.access(repoPath);
        // If repo exists, pull
        console.log(`Pulling repo: ${repoName}`);
        await execPromise(`git -C ${repoPath} pull --ff-only`, { timeout: 60000 });
    } catch (e) {
        if (e.code === 'ENOENT') {
            // If repo does not exist, clone
            console.log(`Cloning repo: ${repoName}`);
            await execPromise(`git clone ${repoUrl} ${repoPath}`, { timeout: 120000 });
        } else {
            throw e;
        }
    }
    return repoPath;
}

/**
 * Gets commit stats for a repository within a 24-hour window using git log.
 */
async function getCommitStats(repoName, targetDate) {
    const repoPath = await cloneOrPullRepo(repoName);

    const endDate = new Date(targetDate);
    endDate.setHours(0, 0, 0, 0);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 1);

    const endISO = formatDate(endDate);
    const startISO = formatDate(startDate);

    // Use git log to get stats: --since and --until are inclusive on date
    // --numstat gives files changed, insertions, and deletions
    const command = `git -C ${repoPath} log --since="${startISO}" --until="${endISO}" --pretty=format:"%an" --numstat`;

    try {
        const { stdout } = await execPromise(command, { maxBuffer: 1024 * 1024 * 10 });
        const lines = stdout.trim().split('\n');
        
        let newCommits = 0;
        let linesAdded = 0;
        let linesDeleted = 0;
        const committers = new Set();

        for (const line of lines) {
            if (line.startsWith('Author:')) {
                // This line is no longer used due to --pretty=format:"%an"
                continue;
            } else if (line.startsWith('"')) {
                // This is the commit message line (which we skip with --pretty=format)
                continue;
            } else if (line.trim() === '') {
                // Separator line
                continue;
            } else if (line.match(/^\w+@/)) {
                // Author name line from --pretty=format:"%an"
                committers.add(line.trim());
                newCommits++;
            } else {
                // Stat line: insertions deletions file
                const parts = line.split('\t');
                if (parts.length === 3) {
                    linesAdded += parseInt(parts[0]) || 0;
                    linesDeleted += parseInt(parts[1]) || 0;
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
        // If git log fails (e.g., empty repo), return zero
        return { new_commits: 0, lines_added: 0, lines_deleted: 0, committers: new Set() };
    }
}

// --- Data Ingestion Service (Cron Job & Backfill) ---

/**
 * Fetches aggregated activity metrics for a given repository for a specific 24-hour period.
 */
async function fetchRepoActivityMetrics(repoName, targetDate) {
    // Calculate the 24-hour window ending at the targetDate's midnight.
    const endDate = new Date(targetDate);
    endDate.setHours(0, 0, 0, 0);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 1);

    const endISO = endDate.toISOString();
    const startISO = startDate.toISOString();

    let activeContributors = new Set();

    // The query string for the specific repository
    const repoQuery = `repo:${ORG_NAME}/${repoName}`;

    // 1. Fetch Issues and PRs created within the window (with delay)
    const createdPrsPromise = githubRest('/search/issues', {
        q: `${repoQuery} is:pr created:${startISO}..${endISO}`,
        per_page: 100,
    });
    
    const createdIssuesPromise = githubRest('/search/issues', {
        q: `${repoQuery} is:issue -is:pr created:${startISO}..${endISO}`,
        per_page: 100,
    });
    
    // 2. Fetch Issues and PRs closed within the window (with delay)
    const closedPrsPromise = githubRest('/search/issues', {
        q: `${repoQuery} is:pr is:closed closed:${startISO}..${endISO}`,
        per_page: 100,
    });
    
    const closedIssuesPromise = githubRest('/search/issues', {
        q: `${repoQuery} is:issue -is:pr is:closed closed:${startISO}..${endISO}`,
        per_page: 100,
    });
    
    const [createdPrs, createdIssues, closedPrs, closedIssuesData] = await Promise.all([
        createdPrsPromise, createdIssuesPromise, closedPrsPromise, closedIssuesPromise
    ]);

    // Aggregate created items
    const newPrs = createdPrs.total_count;
    createdPrs.items.forEach(item => activeContributors.add(item.user.login));
    
    const newIssues = createdIssues.total_count;
    createdIssues.items.forEach(item => activeContributors.add(item.user.login));

    // Aggregate closed items
    const closedMergedPrs = closedPrs.total_count;
    closedPrs.items.forEach(item => activeContributors.add(item.user.login));
    
    const closedIssues = closedIssuesData.total_count;
    closedIssuesData.items.forEach(item => activeContributors.add(item.user.login));
 
    // 3. Get Commit Stats (Local Git Clone)
    const commitStats = await getCommitStats(repoName, targetDate);

    commitStats.committers.forEach(committer => activeContributors.add(committer));

    return {
        new_prs: newPrs,
        closed_merged_prs: closedMergedPrs,
        new_issues: newIssues,
        closed_issues: closedIssues,
        active_contributors: activeContributors.size,
        new_commits: commitStats.new_commits,
        lines_added: commitStats.lines_added,
        lines_deleted: commitStats.lines_deleted,
    };
}

/**
 * Stores the activity snapshot for a specific date for a repository.
 */
async function fetchAndStoreRepoActivity(repoId, repoName, sigId, targetDate) {
    const targetDateStr = formatDate(targetDate);

    console.log(`Fetching data for repo ${repoName} (SIG:${sigId}) on ${targetDateStr}`);

    let metrics;
    try {
        metrics = await fetchRepoActivityMetrics(repoName, targetDate);
    } catch (error) {
        console.error(`Failed to fetch metrics for repo ${repoName} on ${targetDateStr}. Storing zero values. Error: ${error.message}`);
        metrics = {
            new_prs: 0,
            closed_merged_prs: 0,
            new_issues: 0,
            closed_issues: 0,
            active_contributors: 0,
            new_commits: 0,
            lines_added: 0,
            lines_deleted: 0,
        };
    }

    try {
        const result = await pool.query(
            `INSERT INTO repo_snapshots (repo_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_commits, lines_added, lines_deleted)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (repo_id, snapshot_date) DO UPDATE
             SET new_prs = EXCLUDED.new_prs,
                 closed_merged_prs = EXCLUDED.closed_merged_prs,
                 new_issues = EXCLUDED.new_issues,
                 closed_issues = EXCLUDED.closed_issues,
                 active_contributors = EXCLUDED.active_contributors,
                 new_commits = EXCLUDED.new_commits,
                 lines_added = EXCLUDED.lines_added,
                 lines_deleted = EXCLUDED.lines_deleted,
                 created_at = NOW()
             RETURNING *`,
            [repoId, targetDateStr, metrics.new_prs, metrics.closed_merged_prs, metrics.new_issues, metrics.closed_issues, metrics.active_contributors, metrics.new_commits, metrics.lines_added, metrics.lines_deleted]
        );
        return result.rows[0];
    } catch (error) {
        console.error(`Error storing data for repo ${repoName} on ${targetDateStr}:`, error.message);
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
    
    // 1. Aggregate from repo_snapshots
    const aggregateResult = await pool.query(
        `SELECT SUM(rs.new_prs) as new_prs,
                SUM(rs.closed_merged_prs) as closed_merged_prs,
                SUM(rs.new_issues) as new_issues,
                SUM(rs.closed_issues) as closed_issues,
                SUM(rs.active_contributors) as active_contributors,
                SUM(rs.new_commits) as new_commits,
                SUM(rs.lines_added) as lines_added,
                SUM(rs.lines_deleted) as lines_deleted
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

    await pool.query(
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
             created_at = NOW()`,
        [sigId, targetDateStr, sigMetrics.new_prs, sigMetrics.closed_merged_prs, sigMetrics.new_issues, sigMetrics.closed_issues, sigMetrics.active_contributors, sigMetrics.new_commits, sigMetrics.lines_added, sigMetrics.lines_deleted]
    );
    return sigMetrics;
}

/**
 * Runs the daily ingestion job for the current day.
 */
async function runDailyIngestionJob() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDateStr = formatDate(today);
    
    console.log('--- Starting Daily Data Ingestion Job ---');
    try {
        // 1. Get the single monitored organization and all SIGs/Repos
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

        const concurrencyLimit = 5; // <-- **关键：设置并发数为5**
        console.log(`Processing ${repositories.length} repos with a concurrency limit of ${concurrencyLimit}`);
        
        // 2. Process each repository with controlled concurrency
        // 将原先的 .map 直接生成 Promise 改为生成 "任务函数"
        const ingestionTasks = repositories.map(repo => 
            () => fetchAndStoreRepoActivity(repo.id, repo.name, repo.sig_id, today)
        );
        
        // 使用我们的新函数来执行任务
        await runPromisesWithConcurrency(ingestionTasks, concurrencyLimit);

        console.log(`Successfully processed all ${repositories.length} repo snapshots for ${todayDateStr}.`);

        // 3. Aggregate Repo Snapshots into SIG Snapshots
        const sigsResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE org_id = $1', [org.id]);
        const sigs = sigsResult.rows;
        
        const sigAggregationPromises = sigs.map(sig => aggregateSigSnapshot(sig.id, today));
        await Promise.all(sigAggregationPromises);
        console.log(`Successfully stored all ${sigs.length} SIG snapshots for ${todayDateStr}.`);

        // 4. Aggregate SIG Snapshots into Organization Snapshot
        const orgAggregationResult = await pool.query(
            `SELECT SUM(ss.new_prs) as new_prs,
                    SUM(ss.closed_merged_prs) as closed_merged_prs,
                    SUM(ss.new_issues) as new_issues,
                    SUM(ss.closed_issues) as closed_issues,
                    SUM(ss.active_contributors) as active_contributors,
                    SUM(ss.new_commits) as new_commits
             FROM sig_snapshots ss
             WHERE ss.snapshot_date = $1`,
            [todayDateStr]
        );
        
        const orgAgg = orgAggregationResult.rows[0];
        const orgMetrics = {
            new_prs: parseInt(orgAgg.new_prs) || 0,
            closed_merged_prs: parseInt(orgAgg.closed_merged_prs) || 0,
            new_issues: parseInt(orgAgg.new_issues) || 0,
            closed_issues: parseInt(orgAgg.closed_issues) || 0,
            active_contributors: parseInt(orgAgg.active_contributors) || 0,
            new_repos: 0,
        };
        
        await pool.query(
            `INSERT INTO activity_snapshots (org_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (org_id, snapshot_date) DO UPDATE
             SET new_prs = EXCLUDED.new_prs,
                 closed_merged_prs = EXCLUDED.closed_merged_prs,
                 new_issues = EXCLUDED.new_issues,
                 closed_issues = EXCLUDED.closed_issues,
                 active_contributors = EXCLUDED.active_contributors,
                 new_repos = EXCLUDED.new_repos,
                 created_at = NOW()`,
            [org.id, todayDateStr, orgMetrics.new_prs, orgMetrics.closed_merged_prs, orgMetrics.new_issues, orgMetrics.closed_issues, orgMetrics.active_contributors, orgMetrics.new_repos]
        );
        console.log(`Successfully stored organization snapshot for ${ORG_NAME} on ${todayDateStr}.`);

        console.log('--- Daily Data Ingestion Job Finished Successfully ---');

    } catch (error) {
        console.error('CRON Job Failed:', error.message);
    }
}

/**
 * Runs a backfill job for the last N days.
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

        for (let i = days; i >= 0; i--) { // Check from days ago up to today
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i);
            const targetDateStr = formatDate(targetDate);

            // 1. Check if all repo data already exists for this date (Backfill logic: only fill if missing)
            const repoCheckResult = await pool.query(
                'SELECT COUNT(*) FROM repo_snapshots WHERE snapshot_date = $1',
                [targetDateStr]
            );
            
            // If data is missing, fetch and store for each repo in parallel
            if (parseInt(repoCheckResult.rows[0].count) < repositories.length) {
                console.log(`Backfilling repo data for ${targetDateStr}.`);
                
                const concurrencyLimit = 5; // <-- **关键：同样设置并发数**

                const backfillTasks = repositories.map(repo => 
                    () => fetchAndStoreRepoActivity(repo.id, repo.name, repo.sig_id, targetDate)
                );
                
                await runPromisesWithConcurrency(backfillTasks, concurrencyLimit);

                console.log(`Repo backfill complete for ${targetDateStr}.`);
            } else {
                console.log(`Data for ${targetDateStr} already complete.`);
            }

            // 2. Aggregate Repo Snapshots into SIG Snapshots
            const sigAggregationPromises = sigs.map(sig => aggregateSigSnapshot(sig.id, targetDate));
            await Promise.all(sigAggregationPromises);
            
            // 3. Aggregate SIG Snapshots into Organization Snapshot
            const orgAggregationResult = await pool.query(
                `SELECT SUM(ss.new_prs) as new_prs,
                        SUM(ss.closed_merged_prs) as closed_merged_prs,
                        SUM(ss.new_issues) as new_issues,
                        SUM(ss.closed_issues) as closed_issues,
                        SUM(ss.active_contributors) as active_contributors,
                        SUM(ss.new_commits) as new_commits
                 FROM sig_snapshots ss
                 WHERE ss.snapshot_date = $1`,
                [targetDateStr]
            );
            
            const orgAgg = orgAggregationResult.rows[0];
            const orgMetrics = {
                new_prs: parseInt(orgAgg.new_prs) || 0,
                closed_merged_prs: parseInt(orgAgg.closed_merged_prs) || 0,
                new_issues: parseInt(orgAgg.new_issues) || 0,
                closed_issues: parseInt(orgAgg.closed_issues) || 0,
                active_contributors: parseInt(orgAgg.active_contributors) || 0,
                new_repos: 0,
            };
            
            await pool.query(
                `INSERT INTO activity_snapshots (org_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (org_id, snapshot_date) DO UPDATE
                 SET new_prs = EXCLUDED.new_prs,
                     closed_merged_prs = EXCLUDED.closed_merged_prs,
                     new_issues = EXCLUDED.new_issues,
                     closed_issues = EXCLUDED.closed_issues,
                     active_contributors = EXCLUDED.active_contributors,
                     new_repos = EXCLUDED.new_repos,
                     created_at = NOW()`,
                [org.id, targetDateStr, orgMetrics.new_prs, orgMetrics.closed_merged_prs, orgMetrics.new_issues, orgMetrics.closed_issues, orgMetrics.active_contributors, orgMetrics.new_repos]
            );
            console.log(`Stored organization snapshot for ${ORG_NAME} on ${targetDateStr}.`);
        }

        console.log('--- Backfill Job Finished Successfully ---');

    } catch (error) {
        console.error('Backfill Job Failed:', error.message);
    }
}

// Schedule the job to run once every 24 hours (e.g., at 00:00 UTC)
// cron.schedule('0 0 * * *', runDailyIngestionJob); // Daily at midnight
cron.schedule('*/5 * * * *', runDailyIngestionJob); // Every 5 minutes for testing

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

// GET /api/v1/sig/:sigId/timeseries - New route for SIG timeseries
app.get('/api/v1/sig/:sigId/timeseries', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d'; // Default to 30 days
    const cacheKey = `sig:${sigId}:range:${range}`;
    const cacheTTL = 60 * 60 * 1; // 1 hour

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

// GET /api/v1/organization/timeseries - Now for the single monitored org
app.get('/api/v1/organization/timeseries', async (req, res) => {
    const range = req.query.range || '30d'; // Default to 30 days
    const cacheKey = `org:${ORG_NAME}:range:${range}`;
    const cacheTTL = 60 * 60 * 1; // 1 hour

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
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos
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

// --- Server Start ---
app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Ensure repo storage path exists
    try {
        await fs.mkdir(REPO_STORAGE_PATH, { recursive: true });
    } catch (e) {
        console.error('Error creating repo storage path:', e.message);
    }

    // Check if any data exists for any repo
    try {
        const checkResult = await pool.query('SELECT COUNT(*) FROM repo_snapshots');
        if (parseInt(checkResult.rows[0].count) === 0) {
            // If no data exists, run backfill for 7 days
            await runBackfillJob(7);
        }
    } catch (e) {
        console.error('Error checking for existing data. Skipping backfill:', e.message);
    }

    // Run the job immediately once on startup for initial data population
    runDailyIngestionJob();
});
