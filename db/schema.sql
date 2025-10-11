-- Table: organizations
CREATE TABLE organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: activity_snapshots
CREATE TABLE activity_snapshots (
    id SERIAL PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    new_prs INTEGER DEFAULT 0,
    closed_merged_prs INTEGER DEFAULT 0,
    new_issues INTEGER DEFAULT 0,
    closed_issues INTEGER DEFAULT 0,
    active_contributors INTEGER DEFAULT 0,
    new_repos INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- Unique constraint to prevent duplicate daily entries for the same organization
    UNIQUE (org_id, snapshot_date)
);

-- Index for faster lookups by organization and date
CREATE INDEX idx_activity_snapshots_org_date ON activity_snapshots (org_id, snapshot_date);
