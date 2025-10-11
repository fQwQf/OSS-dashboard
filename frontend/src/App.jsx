import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import ReactECharts from 'echarts-for-react';
import './index.css'; // Import the basic styles

const API_BASE_URL = 'http://localhost:3000/api/v1'; // Should be configured via Vite env

function App() {
  const [organizations, setOrganizations] = useState([]);
  const [selectedOrg, setSelectedOrg] = useState('');
  const [timeseriesData, setTimeseriesData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch list of monitored organizations on component mount
  useEffect(() => {
    const fetchOrganizations = async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/organizations`);
        setOrganizations(response.data);
        if (response.data.length > 0) {
          setSelectedOrg(response.data[0]); // Select the first organization by default
        }
      } catch (err) {
        console.error('Error fetching organizations:', err);
        setError('无法加载组织列表。请确保后端服务已运行。');
      }
    };
    fetchOrganizations();
  }, []);

  // Fetch timeseries data when selectedOrg changes
  useEffect(() => {
    if (!selectedOrg) return;

    const fetchTimeseries = async () => {
      setLoading(true);
      setError(null);
      try {
        // Default range is 30 days as per requirement
        const response = await axios.get(`${API_BASE_URL}/organizations/${selectedOrg}/timeseries?range=30d`);
        setTimeseriesData(response.data);
      } catch (err) {
        console.error('Error fetching timeseries data:', err);
        if (err.response && err.response.status === 403) {
            setError(`组织 "${selectedOrg}" 未被监控或访问被拒绝 (403)。`);
        } else {
            setError('加载时间序列数据失败。');
        }
        setTimeseriesData([]);
      } finally {
        setLoading(false);
      }
    };
    fetchTimeseries();
  }, [selectedOrg]);

  // Extract the latest snapshot data for the data cards
  const latestSnapshot = useMemo(() => {
    if (timeseriesData.length === 0) return null;
    // Data is sorted by date ASC from the backend, so the last element is the latest
    return timeseriesData[timeseriesData.length - 1];
  }, [timeseriesData]);

  // ECharts configuration
  const chartOptions = useMemo(() => {
    if (timeseriesData.length === 0) {
      return {};
    }

    const dates = timeseriesData.map(d => d.date);
    const newPrs = timeseriesData.map(d => d.new_prs);
    const closedMergedPrs = timeseriesData.map(d => d.closed_merged_prs);
    const newIssues = timeseriesData.map(d => d.new_issues);
    const closedIssues = timeseriesData.map(d => d.closed_issues);

    return {
      title: {
        text: `${selectedOrg} 社区活动趋势 (近 30 天)`,
        left: 'center',
        textStyle: {
            color: '#fff'
        }
      },
      tooltip: {
        trigger: 'axis'
      },
      legend: {
        data: ['新增 PR', '合并 PR', '新增 Issue', '关闭 Issue'],
        top: 30,
        textStyle: {
            color: '#ccc'
        }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: dates,
        axisLabel: {
            color: '#ccc'
        }
      },
      yAxis: {
        type: 'value',
        axisLabel: {
            color: '#ccc'
        }
      },
      series: [
        {
          name: '新增 PR',
          type: 'line',
          data: newPrs,
          smooth: true,
          lineStyle: { color: '#646cff' }
        },
        {
          name: '合并 PR',
          type: 'line',
          data: closedMergedPrs,
          smooth: true,
          lineStyle: { color: '#4CAF50' }
        },
        {
          name: '新增 Issue',
          type: 'line',
          data: newIssues,
          smooth: true,
          lineStyle: { color: '#FFC107' }
        },
        {
          name: '关闭 Issue',
          type: 'line',
          data: closedIssues,
          smooth: true,
          lineStyle: { color: '#F44336' }
        }
      ]
    };
  }, [timeseriesData, selectedOrg]);

  const handleOrgChange = (event) => {
    setSelectedOrg(event.target.value);
  };

  return (
    <div className="App">
      <h1>OSS 社区活动仪表板</h1>

      {/* 1. Organization Selector */}
      <select value={selectedOrg} onChange={handleOrgChange} disabled={organizations.length === 0 || loading}>
        <option value="" disabled>请选择一个组织</option>
        {organizations.map(org => (
          <option key={org} value={org}>{org}</option>
        ))}
      </select>

      {error && <p style={{ color: 'red' }}>错误: {error}</p>}
      {loading && <p>正在加载数据...</p>}

      {latestSnapshot && (
        <>
          <h2>{selectedOrg} 最新活动快照 ({latestSnapshot.date})</h2>
          {/* 2. Data Cards */}
          <div className="card-container">
            <div className="data-card">
              <h3>新增 PR</h3>
              <p>{latestSnapshot.new_prs}</p>
            </div>
            <div className="data-card">
              <h3>合并 PR</h3>
              <p>{latestSnapshot.closed_merged_prs}</p>
            </div>
            <div className="data-card">
              <h3>活跃贡献者</h3>
              <p>{latestSnapshot.active_contributors}</p>
            </div>
            <div className="data-card">
              <h3>新增 Issue</h3>
              <p>{latestSnapshot.new_issues}</p>
            </div>
            <div className="data-card">
              <h3>新增仓库</h3>
              <p>{latestSnapshot.new_repos}</p>
            </div>
          </div>

          {/* 3. Chart Area */}
          <div className="chart-area">
            <ReactECharts option={chartOptions} style={{ height: '100%', width: '100%' }} />
          </div>
        </>
      )}
      {!selectedOrg && organizations.length > 0 && <p>请从下拉菜单中选择一个组织以查看数据。</p>}
      {organizations.length === 0 && !loading && !error && <p>未找到任何可监控的组织。请检查数据库配置和数据填充。</p>}
    </div>
  );
}

export default App;
