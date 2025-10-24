import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import ReactECharts from 'echarts-for-react';
import './index.css';

const API_BASE_URL = 'http://localhost:3000/api/v1';
const ITEMS_PER_PAGE = 10;

// Component for Pagination Controls (Unchanged)
const Pagination = ({ currentPage, totalCount, onPageChange, type }) => {
  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
  const startItem = (currentPage - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(currentPage * ITEMS_PER_PAGE, totalCount);

  if (totalCount === 0) return null;

  return (
    <div className="pagination-controls">
      <span>
        {type === 'prs' ? 'PR' : 'Issue'} 总数: {totalCount} | 显示 {startItem}-{endItem} 条
      </span>
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
      >
        &larr; 上一页
      </button>
      <span className="page-info">
        第 {currentPage} / {totalPages} 页
      </span>
      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
      >
        下一页 &rarr;
      </button>
    </div>
  );
};

// Component to display a list of activities (PRs or Issues) (Unchanged)
const ActivityList = ({ title, activities, totalCount, currentPage, onPageChange, type }) => (
  <div className="activity-list-container">
    <h3>{title}</h3>
    <Pagination
      currentPage={currentPage}
      totalCount={totalCount}
      onPageChange={onPageChange}
      type={type}
    />
    {activities.length === 0 ? (
      <p>暂无最新活动。</p>
    ) : (
      <ul className="activity-list">
        {activities.map((item) => (
          <li key={item.id} className="activity-item">
            <a href={item.url} target="_blank" rel="noopener noreferrer" title={item.title}>
              {item.title}
            </a>
            <div className="activity-meta">
              <span className="repo-name">[{item.repo}]</span>
              <span className="author">@{item.author}</span>
              <span className={`state state-${item.state}`}>{item.state}</span>
            </div>
          </li>
        ))}
      </ul>
    )}
    <Pagination
      currentPage={currentPage}
      totalCount={totalCount}
      onPageChange={onPageChange}
      type={type}
    />
  </div>
);

// Component for the ECharts trend graph (Updated to include Commit data)
const SigTrendChart = ({ sigName, data }) => {
    const chartOptions = useMemo(() => {
        if (data.length === 0) {
            return { title: { text: `${sigName} - 暂无数据`, left: 'center', textStyle: { color: '#ccc' } } };
        }

        const dates = data.map(d => d.date);
        const newPrs = data.map(d => d.new_prs);
        const closedMergedPrs = data.map(d => d.closed_merged_prs);
        const newIssues = data.map(d => d.new_issues);
        const closedIssues = data.map(d => d.closed_issues);
        const newCommits = data.map(d => d.new_commits);
        const linesAdded = data.map(d => d.lines_added);
        const linesDeleted = data.map(d => d.lines_deleted);

        return {
            title: {
                text: `${sigName} 活动趋势 (近 30 天)`,
                left: 'center',
                textStyle: { color: '#fff' }
            },
            tooltip: { trigger: 'axis' },
            legend: {
                data: ['新增 PR', '合并 PR', '新增 Issue', '关闭 Issue', '新增 Commit', '新增行数', '删除行数'],
                top: 30,
                textStyle: { color: '#ccc' }
            },
            grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
            xAxis: { type: 'category', boundaryGap: false, data: dates, axisLabel: { color: '#ccc' } },
            yAxis: [
                { type: 'value', name: '数量', min: 0, axisLabel: { color: '#ccc' } },
                { type: 'value', name: '行数', min: 0, axisLabel: { color: '#ccc' } }
            ],
            series: [
                { name: '新增 PR', type: 'line', data: newPrs, smooth: true, lineStyle: { color: '#646cff' } },
                { name: '合并 PR', type: 'line', data: closedMergedPrs, smooth: true, lineStyle: { color: '#4CAF50' } },
                { name: '新增 Issue', type: 'line', data: newIssues, smooth: true, lineStyle: { color: '#FFC107' } },
                { name: '关闭 Issue', type: 'line', data: closedIssues, smooth: true, lineStyle: { color: '#F44336' } },
                { name: '新增 Commit', type: 'line', data: newCommits, smooth: true, lineStyle: { color: '#9C27B0' } },
                { name: '新增行数', type: 'line', data: linesAdded, smooth: true, yAxisIndex: 1, lineStyle: { color: '#00BCD4' } },
                { name: '删除行数', type: 'line', data: linesDeleted, smooth: true, yAxisIndex: 1, lineStyle: { color: '#FF5722' } }
            ]
        };
    }, [data, sigName]);

    return (
        <div className="sig-chart-card">
            <ReactECharts option={chartOptions} style={{ height: '400px', width: '100%' }} />
        </div>
    );
};


function App() {
  const [sigs, setSigs] = useState([]);
  const [selectedSigId, setSelectedSigId] = useState(null);
  const [sigTimeseriesData, setSigTimeseriesData] = useState([]);
  const [orgTimeseriesData, setOrgTimeseriesData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // State for PRs (Organization-wide)
  const [prsData, setPrsData] = useState({ activities: [], total_count: 0, page: 1 });
  // State for Issues (Organization-wide)
  const [issuesData, setIssuesData] = useState({ activities: [], total_count: 0, page: 1 });
  const [activityLoading, setActivityLoading] = useState(false);


  // Fetch list of monitored SIGs on component mount
  useEffect(() => {
    const fetchSigs = async () => {
      setLoading(true);
      try {
        const response = await axios.get(`${API_BASE_URL}/organization/sigs`);
        setSigs(response.data);
        if (response.data.length > 0) {
          setSelectedSigId(response.data[0].id); // Select the first SIG by default
        }
      } catch (err) {
        console.error('Error fetching SIGs:', err);
        setError('无法加载 SIG 列表。请确保后端服务已运行并配置正确。');
      } finally {
        setLoading(false);
      }
    };
    
    const fetchOrgTimeseries = async () => {
        try {
            const response = await axios.get(`${API_BASE_URL}/organization/timeseries?range=30d`);
            setOrgTimeseriesData(response.data);
        } catch (err) {
            console.error('Error fetching organization timeseries data:', err);
            setOrgTimeseriesData([]);
        }
    };
    
    fetchSigs();
    fetchOrgTimeseries();
  }, []);

  // Fetch SIG timeseries data when selectedSigId changes
  useEffect(() => {
    if (!selectedSigId) return;

    const fetchTimeseries = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await axios.get(`${API_BASE_URL}/sig/${selectedSigId}/timeseries?range=30d`);
        setSigTimeseriesData(response.data);
      } catch (err) {
        console.error('Error fetching SIG timeseries data:', err);
        setError('加载 SIG 时间序列数据失败。');
        setSigTimeseriesData([]);
      } finally {
        setLoading(false);
      }
    };
    fetchTimeseries();
    
  }, [selectedSigId]);
  
  // Function to fetch organization-wide activities with pagination (Unchanged)
  const fetchActivities = useCallback(async (type, page) => {
    const params = {
      type: type,
      page: page,
      per_page: ITEMS_PER_PAGE,
    };

    try {
      const response = await axios.get(`${API_BASE_URL}/organization/latest-activity`, { params });
      return response.data;
    } catch (err) {
      console.error(`Error fetching latest ${type} activities:`, err);
      return { activities: [], total_count: 0, page: 1 };
    }
  }, []);
  
  // Fetch latest organization-wide activities (PRs and Issues) when page changes (Updated dependency)
  useEffect(() => {
    if (sigs.length === 0) return;

    const loadActivities = async () => {
      setActivityLoading(true);
      
      // Fetch PRs for current page
      const prsResult = await fetchActivities('prs', prsData.page);
      setPrsData(prev => ({ ...prev, activities: prsResult.activities, total_count: prsResult.total_count, per_page: prsResult.per_page }));

      // Fetch Issues for current page
      const issuesResult = await fetchActivities('issues', issuesData.page);
      setIssuesData(prev => ({ ...prev, activities: issuesResult.activities, total_count: issuesResult.total_count, per_page: issuesResult.per_page }));

      setActivityLoading(false);
    };
    
    loadActivities();
  }, [sigs, prsData.page, issuesData.page, fetchActivities]);

  // Handlers for page change (Unchanged)
  const handlePrsPageChange = (newPage) => {
    setPrsData(prev => ({ ...prev, page: newPage }));
  };

  const handleIssuesPageChange = (newPage) => {
    setIssuesData(prev => ({ ...prev, page: newPage }));
  };
  
  const selectedSig = useMemo(() => {
      return sigs.find(sig => sig.id === selectedSigId);
  }, [sigs, selectedSigId]);

  // Extract the latest snapshot data for the data cards (using organization-wide timeseries)
  const latestOrgSnapshot = useMemo(() => {
    if (orgTimeseriesData.length === 0) return null;
    // The latest snapshot is the last element in the array
    const latest = orgTimeseriesData[orgTimeseriesData.length - 1];
    
    // Also calculate latest commit stats for the card
    const latestSigSnapshot = sigTimeseriesData[sigTimeseriesData.length - 1];
    
    return {
        date: latest.date,
        // Metrics from activity_snapshots
        new_prs: latest.new_prs,
        closed_merged_prs: latest.closed_merged_prs,
        active_contributors: latest.active_contributors,
        new_issues: latest.new_issues,
        // Commit metrics from the currently selected SIG (approximation for card)
        new_commits: latestSigSnapshot?.new_commits || 0,
        lines_added: latestSigSnapshot?.lines_added || 0,
        lines_deleted: latestSigSnapshot?.lines_deleted || 0,
    };
  }, [orgTimeseriesData, sigTimeseriesData]);


  return (
    <div className="App">
      <h1>华中科技大学开放原子开源俱乐部活动仪表板</h1>
      <h2>组织总览快照 ({latestOrgSnapshot?.date || '加载中...'})</h2>

      {error && <p style={{ color: 'red' }}>错误: {error}</p>}
      {loading && <p>正在加载 SIG 列表和数据...</p>}

      {latestOrgSnapshot && (
        <>
          {/* 1. Data Cards (Based on Organization-wide data) */}
          <div className="card-container">
            <div className="data-card">
              <h3>新增 PR</h3>
              <p>{latestOrgSnapshot.new_prs}</p>
            </div>
            <div className="data-card">
              <h3>合并 PR</h3>
              <p>{latestOrgSnapshot.closed_merged_prs}</p>
            </div>
            <div className="data-card">
              <h3>活跃贡献者</h3>
              <p>{latestOrgSnapshot.active_contributors}</p>
            </div>
            <div className="data-card">
              <h3>新增 Issue</h3>
              <p>{latestOrgSnapshot.new_issues}</p>
            </div>
            {/* New Commit Stats Cards */}
            <div className="data-card commit-card">
              <h3>新增 Commit</h3>
              <p>{latestOrgSnapshot.new_commits}</p>
            </div>
            <div className="data-card commit-card">
              <h3>新增行数</h3>
              <p>{latestOrgSnapshot.lines_added}</p>
            </div>
            <div className="data-card commit-card">
              <h3>删除行数</h3>
              <p>{latestOrgSnapshot.lines_deleted}</p>
            </div>
          </div>

          {/* 2. SIG Selector and Trend Chart */}
          <h2 style={{ marginTop: '40px' }}>SIG 活动趋势</h2>
          <div className="sig-selector-container">
              <select value={selectedSigId || ''} onChange={(e) => setSelectedSigId(parseInt(e.target.value))}>
                <option value="" disabled>请选择一个 SIG</option>
                {sigs.map(sig => (
                  <option key={sig.id} value={sig.id}>{sig.name}</option>
                ))}
              </select>
          </div>
          
          <div className="chart-area">
            <SigTrendChart sigName={selectedSig?.name} data={sigTimeseriesData} />
          </div>

          {/* 3. Latest Activity Lists (Organization-wide) */}
          <h2 style={{ marginTop: '40px' }}>最新活动详情 (组织范围)</h2>
          {activityLoading ? (
            <p>正在加载最新活动列表...</p>
          ) : (
            <div className="activity-lists-wrapper">
              <ActivityList 
                title="最新 Pull Requests (PR)" 
                activities={prsData.activities} 
                totalCount={prsData.total_count}
                currentPage={prsData.page}
                onPageChange={handlePrsPageChange}
                type="prs"
              />
              <ActivityList 
                title="最新 Issues" 
                activities={issuesData.activities} 
                totalCount={issuesData.total_count}
                currentPage={issuesData.page}
                onPageChange={handleIssuesPageChange}
                type="issues"
              />
            </div>
          )}
        </>
      )}
      {sigs.length === 0 && !loading && !error && <p>未找到任何可监控的 SIG。请检查数据库配置和数据填充。</p>}
    </div>
  );
}

export default App;
