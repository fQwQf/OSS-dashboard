import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import ReactECharts from 'echarts-for-react';
import './index.css';

const API_BASE_URL = 'http://localhost:3000/api/v1';
const ITEMS_PER_PAGE = 10;

// --- Helper function to merge timeseries data ---
const mergeTimeseriesData = (sourceArrays) => {
    const dataMap = new Map();
    sourceArrays.forEach(arr => {
        if (!arr) return;
        arr.forEach(d => {
            const existing = dataMap.get(d.date) || { date: d.date };
            dataMap.set(d.date, { ...existing, ...d });
        });
    });
    return Array.from(dataMap.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
};

// --- Sub-Components (Unchanged) ---

// Component for Pagination Controls
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
      <div>
        <button onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}>
          &larr; 上一页
        </button>
        <span className="page-info">
          第 {currentPage} / {totalPages} 页
        </span>
        <button onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= totalPages}>
          下一页 &rarr;
        </button>
      </div>
    </div>
  );
};

// Component to display a list of activities (PRs or Issues)
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
  </div>
);

// Component for the ECharts trend graph
const SigTrendChart = ({ sigName, data }) => {
    const chartOptions = useMemo(() => {
        if (!data || data.length === 0) {
            return { title: { text: `${sigName || 'SIG'} - 正在加载图表数据...`, left: 'center', textStyle: { color: '#ccc' } } };
        }

        const dates = data.map(d => d.date);
        
        return {
            title: { text: `${sigName} 活动趋势 (近 30 天)`, left: 'center', textStyle: { color: '#fff' } },
            tooltip: { trigger: 'axis' },
            legend: {
                data: ['新增 PR', '合并 PR', '新增 Issue', '关闭 Issue', '新增 Commit', '新增行数', '删除行数'],
                top: 40,
                textStyle: { color: '#ccc' },
                type: 'scroll'
            },
            grid: { top: 80, left: '3%', right: '4%', bottom: '3%', containLabel: true },
            xAxis: { type: 'category', boundaryGap: false, data: dates, axisLabel: { color: '#ccc' } },
            yAxis: [
                { type: 'value', name: '数量', min: 0, axisLabel: { color: '#ccc' } },
                { type: 'value', name: '行数', min: 0, axisLabel: { color: '#ccc' }, splitLine: { show: false } }
            ],
            series: [
                { name: '新增 PR', type: 'line', data: data.map(d => d.new_prs), smooth: true, lineStyle: { color: '#646cff' } },
                { name: '合并 PR', type: 'line', data: data.map(d => d.closed_merged_prs), smooth: true, lineStyle: { color: '#4CAF50' } },
                { name: '新增 Issue', type: 'line', data: data.map(d => d.new_issues), smooth: true, lineStyle: { color: '#FFC107' } },
                { name: '关闭 Issue', type: 'line', data: data.map(d => d.closed_issues), smooth: true, lineStyle: { color: '#F44336' } },
                { name: '新增 Commit', type: 'line', data: data.map(d => d.new_commits), smooth: true, lineStyle: { color: '#9C27B0' } },
                { name: '新增行数', type: 'line', data: data.map(d => d.lines_added), smooth: true, yAxisIndex: 1, lineStyle: { color: '#00BCD4' } },
                { name: '删除行数', type: 'line', data: data.map(d => d.lines_deleted), smooth: true, yAxisIndex: 1, lineStyle: { color: '#FF5722' } }
            ]
        };
    }, [data, sigName]);

    return (
        <div className="sig-chart-card">
            <ReactECharts option={chartOptions} style={{ height: '100%', width: '100%' }} notMerge={true} lazyUpdate={true} />
        </div>
    );
};


// --- Main App Component (Modified) ---
function App() {
  const [sigs, setSigs] = useState([]);
  const [selectedSigId, setSelectedSigId] = useState(null);
  
  // States for SIG-specific data
  const [sigCommitData, setSigCommitData] = useState([]);
  const [sigApiData, setSigApiData] = useState([]);
  const [sigSummary, setSigSummary] = useState(null);

  const [loading, setLoading] = useState({ sigs: true, sig: true });
  const [error, setError] = useState(null);
  
  const [prsData, setPrsData] = useState({ activities: [], total_count: 0, page: 1 });
  const [issuesData, setIssuesData] = useState({ activities: [], total_count: 0, page: 1 });
  const [activityLoading, setActivityLoading] = useState(false);

  // Effect for initial SIGs list load
  useEffect(() => {
    const fetchSigs = async () => {
      setLoading(prev => ({ ...prev, sigs: true }));
      setError(null);
      try {
        const sigsResponse = await axios.get(`${API_BASE_URL}/organization/sigs`);
        setSigs(sigsResponse.data);
        
        if (sigsResponse.data.length > 0) {
          setSelectedSigId(sigsResponse.data[0].id);
        }
      } catch (err) {
          console.error('Error fetching initial sigs list:', err);
          setError('无法加载仪表板核心数据 (SIG列表)。请确保后端服务正常。');
        } finally {
          setLoading(prev => ({ ...prev, sigs: false }));
        }
      };
      fetchSigs();
  }, []);

  // Effect for fetching all data when the selected SIG changes
  useEffect(() => {
    if (!selectedSigId) return;

    const fetchSigData = async () => {
      setLoading(prev => ({ ...prev, sig: true }));
      // Clear previous SIG data to avoid showing stale chart or cards
      setSigCommitData([]);
      setSigApiData([]);
      setSigSummary(null); 
      try {
        // Fetch timeseries and summary data in parallel for the selected SIG
        const [sigCommitResponse, sigApiResponse, sigSummaryResponse] = await Promise.all([
          axios.get(`${API_BASE_URL}/sig/${selectedSigId}/timeseries/commits?range=30d`),
          axios.get(`${API_BASE_URL}/sig/${selectedSigId}/timeseries/api?range=30d`),
          axios.get(`${API_BASE_URL}/sig/${selectedSigId}/summary?range=30d`)
        ]);
        setSigCommitData(sigCommitResponse.data);
        setSigApiData(sigApiResponse.data);
        setSigSummary(sigSummaryResponse.data);
      } catch (err) {
        console.error(`Error fetching data for SIG ${selectedSigId}:`, err);
        // Optionally set a SIG-specific error message here
      } finally {
        setLoading(prev => ({ ...prev, sig: false }));
      }
    };
    fetchSigData();
  }, [selectedSigId]);
  
  // Effect for fetching PRs/Issues (runs once)
  const fetchActivities = useCallback(async (type, page) => {
    setActivityLoading(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/organization/latest-activity`, { 
        params: { type, page, per_page: ITEMS_PER_PAGE } 
      });
      if (type === 'prs') {
        setPrsData({ activities: response.data.activities, total_count: response.data.total_count, page });
      } else {
        setIssuesData({ activities: response.data.activities, total_count: response.data.total_count, page });
      }
    } catch (err) {
      console.error(`Error fetching latest ${type}:`, err);
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActivities('prs', 1);
    fetchActivities('issues', 1);
  }, [fetchActivities]);

  const handlePrsPageChange = (newPage) => fetchActivities('prs', newPage);
  const handleIssuesPageChange = (newPage) => fetchActivities('issues', newPage);
  
  // Memoized selectors for deriving data for rendering
  const selectedSigName = useMemo(() => sigs.find(sig => sig.id === selectedSigId)?.name, [sigs, selectedSigId]);
  const mergedSigData = useMemo(() => mergeTimeseriesData([sigCommitData, sigApiData]), [sigCommitData, sigApiData]);

  const isCoreLoading = loading.sigs;

  return (
    <div className="App">
      <header>
        <h1>华中科技大学开放原子开源俱乐部活动仪表板</h1>
      </header>
      
      {error && <p className="error-message">错误: {error}</p>}
      {isCoreLoading && <p>正在加载SIG列表...</p>}

      {!isCoreLoading && !error && (
        <main>
          <section className="sig-section">
            <h2>SIG 表现</h2>
            <div className="sig-selector-container">
              <label htmlFor="sig-select">选择 SIG:</label>
              <select 
                id="sig-select" 
                value={selectedSigId || ''} 
                onChange={(e) => setSelectedSigId(parseInt(e.target.value))}
                disabled={loading.sig}
              >
                {sigs.map(sig => <option key={sig.id} value={sig.id}>{sig.name}</option>)}
              </select>
            </div>

            {/* Display loading message or the SIG data (summary cards + chart) */}
            {loading.sig ? <p className="loading-text">正在加载 {selectedSigName || ''} 的数据...</p> : (
              <>
                <h3 className="sig-summary-title">
                  {selectedSigName} 汇总 (过去 {sigSummary?.range_days ?? '30'} 天)
                </h3>
                <div className="card-container sig-summary-cards">
                  <div className="data-card"><h3 title="New Pull Requests">新增 PR</h3><p>{sigSummary?.new_prs ?? '0'}</p></div>
                  <div className="data-card"><h3 title="Merged Pull Requests">合并 PR</h3><p>{sigSummary?.closed_merged_prs ?? '0'}</p></div>
                  <div className="data-card"><h3 title="New Issues">新增 Issue</h3><p>{sigSummary?.new_issues ?? '0'}</p></div>
                  <div className="data-card commit-card"><h3 title="New Commits">新增 Commit</h3><p>{sigSummary?.new_commits ?? '0'}</p></div>
                  <div className="data-card commit-card"><h3 title="Lines Added">新增行数</h3><p>{sigSummary?.lines_added ?? '0'}</p></div>
                  <div className="data-card commit-card"><h3 title="Lines Deleted">删除行数</h3><p>{sigSummary?.lines_deleted ?? '0'}</p></div>
                </div>

                <SigTrendChart sigName={selectedSigName} data={mergedSigData} />
              </>
            )}
          </section>

          <section className="activity-section">
            <h2>最新活动详情 (组织范围)</h2>
            {activityLoading ? <p className="loading-text">正在加载活动列表...</p> : (
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
          </section>
        </main>
      )}
    </div>
  );
}

export default App;