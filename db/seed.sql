-- Sample SQL script to insert initial organizations for testing
INSERT INTO organizations (name) VALUES
('microsoft'),
('hust-open-atom-club'),
('WHULUG')
ON CONFLICT (name) DO NOTHING;
