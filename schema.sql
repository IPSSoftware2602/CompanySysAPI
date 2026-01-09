-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ENUM Types
CREATE TYPE user_role AS ENUM ('CEO', 'TECH_LEAD', 'PM', 'QA', 'DEV', 'FINANCE', 'ADMIN');
CREATE TYPE project_status AS ENUM ('ACTIVE', 'MAINTENANCE', 'ARCHIVED', 'PENDING', 'ONGOING');
CREATE TYPE ticket_type AS ENUM ('FEATURE', 'BUG', 'CHANGE_REQUEST');
CREATE TYPE ticket_status AS ENUM ('BACKLOG', 'TECH_DESIGN', 'READY_FOR_DEV', 'IN_PROGRESS', 'CODE_REVIEW', 'QA', 'READY_TO_DEPLOY', 'DONE');
CREATE TYPE checklist_required_for AS ENUM ('CODE_REVIEW', 'READY_FOR_DEV');

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
);

-- Projects Table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    client_name VARCHAR(255),
    status project_status DEFAULT 'ACTIVE',
    payment_status BOOLEAN DEFAULT FALSE, -- False = Unpaid, True = Paid
    tech_lead_id UUID REFERENCES users(id),
    pm_id UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tickets Table
CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    type ticket_type NOT NULL,
    status ticket_status DEFAULT 'BACKLOG',
    assigned_to_user_id UUID REFERENCES users(id),
    due_date TIMESTAMP WITH TIME ZONE,
    attachments JSONB DEFAULT '[]', -- Array of {name, url, type}
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Comments Table
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Labels Table
CREATE TABLE IF NOT EXISTS labels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) NOT NULL,
    color VARCHAR(20) NOT NULL, -- Hex code or preset name
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE
);

-- Ticket Labels Junction Table
CREATE TABLE IF NOT EXISTS ticket_labels (
    ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
    label_id UUID REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, label_id)
);

-- Checklist Templates Table
CREATE TABLE IF NOT EXISTS checklist_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    items JSONB NOT NULL, -- Array of strings or objects
    required_for_status checklist_required_for NOT NULL
);

-- Checklist Submissions Table
CREATE TABLE IF NOT EXISTS checklist_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
    template_id UUID REFERENCES checklist_templates(id),
    submitted_by_user_id UUID REFERENCES users(id),
    completed_items JSONB NOT NULL, -- Key-value pairs
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ticket Transitions Table (Audit Log)
CREATE TABLE IF NOT EXISTS ticket_transitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
    from_status ticket_status,
    to_status ticket_status NOT NULL,
    performed_by_user_id UUID REFERENCES users(id),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Initial Seed Data (Optional, for testing)
INSERT INTO checklist_templates (name, items, required_for_status) VALUES 
('Pre-PR Checklist', '[
    {"id": "ui_responsive", "text": "UI Responsive Check (Mobile/Desktop)"},
    {"id": "no_console_logs", "text": "No console.logs or debug prints"},
    {"id": "unit_tests", "text": "Unit Tests Passed"},
    {"id": "code_formatted", "text": "Code Formatted"}
]', 'CODE_REVIEW')
ON CONFLICT DO NOTHING;
