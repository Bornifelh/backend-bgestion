require('dotenv').config({ path: '../../.env' });
const db = require('./db');
const logger = require('../utils/logger');

const migrations = `
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  avatar_url TEXT,
  role VARCHAR(50) DEFAULT 'user',
  is_active BOOLEAN DEFAULT true,
  must_change_password BOOLEAN DEFAULT false,
  last_login TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add must_change_password column if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'must_change_password') THEN
    ALTER TABLE users ADD COLUMN must_change_password BOOLEAN DEFAULT false;
  END IF;
END $$;

-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(50),
  color VARCHAR(7) DEFAULT '#6366f1',
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Workspace members table
CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'member',
  invited_by UUID REFERENCES users(id),
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id)
);

-- Boards table
CREATE TABLE IF NOT EXISTS boards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(50) DEFAULT 'board',
  icon VARCHAR(50),
  color VARCHAR(7) DEFAULT '#6366f1',
  is_private BOOLEAN DEFAULT false,
  owner_id UUID REFERENCES users(id),
  position INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Column types table
CREATE TABLE IF NOT EXISTS column_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  component VARCHAR(100) NOT NULL,
  default_settings JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Columns table
CREATE TABLE IF NOT EXISTS columns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
  column_type_id UUID REFERENCES column_types(id),
  title VARCHAR(255) NOT NULL,
  width INTEGER DEFAULT 150,
  position INTEGER DEFAULT 0,
  settings JSONB DEFAULT '{}',
  is_visible BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Groups table (for grouping items)
CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  color VARCHAR(7) DEFAULT '#6366f1',
  position INTEGER DEFAULT 0,
  is_collapsed BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Items table
CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
  group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
  name VARCHAR(500) NOT NULL,
  position INTEGER DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Item values table (stores cell values)
CREATE TABLE IF NOT EXISTS item_values (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  column_id UUID REFERENCES columns(id) ON DELETE CASCADE,
  value JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_id, column_id)
);

-- Status labels table
CREATE TABLE IF NOT EXISTS status_labels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  column_id UUID REFERENCES columns(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL,
  color VARCHAR(7) NOT NULL,
  position INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Item subscribers (users subscribed to item updates)
CREATE TABLE IF NOT EXISTS item_subscribers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_id, user_id)
);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Activity log table
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID,
  old_value JSONB,
  new_value JSONB,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  data JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- File attachments table
CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  file_name VARCHAR(255) NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  file_type VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Views table (different board views)
CREATE TABLE IF NOT EXISTS views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'table',
  settings JSONB DEFAULT '{}',
  filters JSONB DEFAULT '[]',
  sorts JSONB DEFAULT '[]',
  hidden_columns UUID[] DEFAULT '{}',
  position INTEGER DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Automations table
CREATE TABLE IF NOT EXISTS automations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  trigger_type VARCHAR(100) NOT NULL,
  trigger_config JSONB DEFAULT '{}',
  action_type VARCHAR(100) NOT NULL,
  action_config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  execution_count INTEGER DEFAULT 0,
  last_executed_at TIMESTAMP WITH TIME ZONE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add missing columns to automations if they don't exist
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'automations' AND column_name = 'description') THEN
    ALTER TABLE automations ADD COLUMN description TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'automations' AND column_name = 'execution_count') THEN
    ALTER TABLE automations ADD COLUMN execution_count INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'automations' AND column_name = 'last_executed_at') THEN
    ALTER TABLE automations ADD COLUMN last_executed_at TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

-- Subtasks table (checklist items within an item)
CREATE TABLE IF NOT EXISTS subtasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  name VARCHAR(500) NOT NULL,
  is_completed BOOLEAN DEFAULT false,
  position INTEGER DEFAULT 0,
  due_date DATE,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id),
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Time tracking table
CREATE TABLE IF NOT EXISTS time_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  description TEXT,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE,
  duration_minutes INTEGER,
  is_billable BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Intervention Tickets table (submitted by users, managed by admins)
CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_number VARCHAR(50) UNIQUE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100) DEFAULT 'general',
  priority VARCHAR(20) DEFAULT 'medium',
  status VARCHAR(50) DEFAULT 'pending',
  urgency VARCHAR(20) DEFAULT 'normal',
  location VARCHAR(255),
  equipment VARCHAR(255),
  requested_date DATE,
  due_date DATE,
  
  -- Assignment (by admin)
  assigned_board_id UUID REFERENCES boards(id) ON DELETE SET NULL,
  assigned_item_id UUID REFERENCES items(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMP WITH TIME ZONE,
  
  -- Resolution
  resolution_notes TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  
  -- Attachments stored as JSON array
  attachments JSONB DEFAULT '[]',
  
  -- Submitter
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_workspace ON tickets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_submitted_by ON tickets(submitted_by);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);

-- Function to generate ticket number
CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS TRIGGER AS $$
DECLARE
  year_prefix TEXT;
  next_num INTEGER;
BEGIN
  year_prefix := TO_CHAR(CURRENT_DATE, 'YYYY');
  SELECT COALESCE(MAX(CAST(SUBSTRING(ticket_number FROM 6) AS INTEGER)), 0) + 1
  INTO next_num
  FROM tickets
  WHERE ticket_number LIKE year_prefix || '-%';
  
  NEW.ticket_number := year_prefix || '-' || LPAD(next_num::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for auto ticket number
DROP TRIGGER IF EXISTS trigger_generate_ticket_number ON tickets;
CREATE TRIGGER trigger_generate_ticket_number
BEFORE INSERT ON tickets
FOR EACH ROW
WHEN (NEW.ticket_number IS NULL)
EXECUTE FUNCTION generate_ticket_number();

-- Templates table
CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(50) DEFAULT 'board',
  template_data JSONB NOT NULL,
  is_public BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Favorites table
CREATE TABLE IF NOT EXISTS favorites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  position INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, entity_type, entity_id)
);

-- Dependencies between items
CREATE TABLE IF NOT EXISTS item_dependencies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  depends_on_id UUID REFERENCES items(id) ON DELETE CASCADE,
  dependency_type VARCHAR(50) DEFAULT 'finish_to_start',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_id, depends_on_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_subtasks_item ON subtasks(item_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_item ON time_entries(item_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_item_dependencies_item ON item_dependencies(item_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_boards_workspace ON boards(workspace_id);
CREATE INDEX IF NOT EXISTS idx_columns_board ON columns(board_id);
CREATE INDEX IF NOT EXISTS idx_items_board ON items(board_id);
CREATE INDEX IF NOT EXISTS idx_items_group ON items(group_id);
CREATE INDEX IF NOT EXISTS idx_item_values_item ON item_values(item_id);
CREATE INDEX IF NOT EXISTS idx_item_values_column ON item_values(column_id);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_board ON activity_logs(board_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_item ON activity_logs(item_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = false;

-- Insert default column types
INSERT INTO column_types (name, component, default_settings) VALUES
  ('text', 'TextColumn', '{"placeholder": "Entrez du texte"}'),
  ('status', 'StatusColumn', '{"labels": []}'),
  ('person', 'PersonColumn', '{"multiple": false}'),
  ('date', 'DateColumn', '{"format": "DD/MM/YYYY", "includeTime": false}'),
  ('number', 'NumberColumn', '{"format": "number", "prefix": "", "suffix": ""}'),
  ('dropdown', 'DropdownColumn', '{"options": [], "multiple": false}'),
  ('checkbox', 'CheckboxColumn', '{}'),
  ('timeline', 'TimelineColumn', '{}'),
  ('files', 'FilesColumn', '{}'),
  ('link', 'LinkColumn', '{}'),
  ('email', 'EmailColumn', '{}'),
  ('phone', 'PhoneColumn', '{}'),
  ('rating', 'RatingColumn', '{"max": 5}'),
  ('tags', 'TagsColumn', '{"tags": []}'),
  ('formula', 'FormulaColumn', '{"formula": ""}'),
  ('progress', 'ProgressColumn', '{}'),
  ('priority', 'PriorityColumn', '{"levels": ["Basse", "Moyenne", "Haute", "Critique"]}')
ON CONFLICT (name) DO NOTHING;

-- Budgets table
CREATE TABLE IF NOT EXISTS budgets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  total_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  spent_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'XAF',
  start_date DATE,
  end_date DATE,
  status VARCHAR(50) DEFAULT 'active',
  color VARCHAR(7) DEFAULT '#6366f1',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Budget categories
CREATE TABLE IF NOT EXISTS budget_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  budget_id UUID REFERENCES budgets(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  allocated_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  color VARCHAR(7) DEFAULT '#6366f1',
  icon VARCHAR(50),
  position INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Budget expenses (transactions)
CREATE TABLE IF NOT EXISTS budget_expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  budget_id UUID REFERENCES budgets(id) ON DELETE CASCADE,
  category_id UUID REFERENCES budget_categories(id) ON DELETE SET NULL,
  item_id UUID REFERENCES items(id) ON DELETE SET NULL,
  description VARCHAR(500) NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  receipt_url TEXT,
  vendor VARCHAR(255),
  notes TEXT,
  status VARCHAR(50) DEFAULT 'approved',
  created_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Team invitations
CREATE TABLE IF NOT EXISTS workspace_invitations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'member',
  token VARCHAR(255) UNIQUE NOT NULL,
  invited_by UUID REFERENCES users(id),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  accepted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for budgets
CREATE INDEX IF NOT EXISTS idx_budgets_workspace ON budgets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_budget_categories_budget ON budget_categories(budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_expenses_budget ON budget_expenses(budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_expenses_category ON budget_expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_token ON workspace_invitations(token);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email ON workspace_invitations(email);

-- Function to update budget spent amount
CREATE OR REPLACE FUNCTION update_budget_spent_amount()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE budgets 
    SET spent_amount = spent_amount + NEW.amount
    WHERE id = NEW.budget_id;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE budgets 
    SET spent_amount = spent_amount - OLD.amount + NEW.amount
    WHERE id = NEW.budget_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE budgets 
    SET spent_amount = spent_amount - OLD.amount
    WHERE id = OLD.budget_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger for budget expenses
DROP TRIGGER IF EXISTS trigger_update_budget_spent ON budget_expenses;
CREATE TRIGGER trigger_update_budget_spent
AFTER INSERT OR UPDATE OR DELETE ON budget_expenses
FOR EACH ROW EXECUTE FUNCTION update_budget_spent_amount();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN 
        SELECT table_name 
        FROM information_schema.columns 
        WHERE column_name = 'updated_at' 
        AND table_schema = 'public'
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS update_%I_updated_at ON %I;
            CREATE TRIGGER update_%I_updated_at
            BEFORE UPDATE ON %I
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        ', t, t, t, t);
    END LOOP;
END;
$$;

-- ============================================
-- SCHEMA DIRECTEUR DES SYSTEMES D'INFORMATION
-- ============================================

-- Strategic axes (axes stratégiques)
CREATE TABLE IF NOT EXISTS sdsi_strategic_axes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  objectives TEXT,
  priority INTEGER DEFAULT 1,
  color VARCHAR(7) DEFAULT '#6366f1',
  icon VARCHAR(50),
  status VARCHAR(50) DEFAULT 'active',
  start_year INTEGER,
  end_year INTEGER,
  position INTEGER DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- SDSI Projects (projets du schéma directeur)
CREATE TABLE IF NOT EXISTS sdsi_projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  axis_id UUID REFERENCES sdsi_strategic_axes(id) ON DELETE SET NULL,
  board_id UUID REFERENCES boards(id) ON DELETE SET NULL,
  code VARCHAR(50),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  objectives TEXT,
  expected_benefits TEXT,
  risks TEXT,
  dependencies TEXT,
  priority VARCHAR(20) DEFAULT 'medium',
  status VARCHAR(50) DEFAULT 'planned',
  complexity VARCHAR(20) DEFAULT 'medium',
  strategic_value INTEGER DEFAULT 5,
  urgency INTEGER DEFAULT 5,
  estimated_budget DECIMAL(15, 2),
  actual_budget DECIMAL(15, 2),
  currency VARCHAR(3) DEFAULT 'XAF',
  start_date DATE,
  end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  progress INTEGER DEFAULT 0,
  sponsor VARCHAR(255),
  project_manager UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Project phases (phases de projet)
CREATE TABLE IF NOT EXISTS sdsi_project_phases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES sdsi_projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  start_date DATE,
  end_date DATE,
  status VARCHAR(50) DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  deliverables TEXT,
  position INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Milestones (jalons)
CREATE TABLE IF NOT EXISTS sdsi_milestones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES sdsi_projects(id) ON DELETE CASCADE,
  phase_id UUID REFERENCES sdsi_project_phases(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  due_date DATE NOT NULL,
  completed_date DATE,
  status VARCHAR(50) DEFAULT 'pending',
  is_critical BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Resources (ressources)
CREATE TABLE IF NOT EXISTS sdsi_resources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  description TEXT,
  capacity DECIMAL(10, 2),
  unit VARCHAR(50),
  cost_per_unit DECIMAL(15, 2),
  currency VARCHAR(3) DEFAULT 'XAF',
  availability_start DATE,
  availability_end DATE,
  skills TEXT[],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Resource allocations (affectations de ressources)
CREATE TABLE IF NOT EXISTS sdsi_resource_allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_id UUID REFERENCES sdsi_resources(id) ON DELETE CASCADE,
  project_id UUID REFERENCES sdsi_projects(id) ON DELETE CASCADE,
  phase_id UUID REFERENCES sdsi_project_phases(id) ON DELETE SET NULL,
  allocation_percentage DECIMAL(5, 2) DEFAULT 100,
  start_date DATE,
  end_date DATE,
  role VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Applications inventory (inventaire des applications)
CREATE TABLE IF NOT EXISTS sdsi_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50),
  description TEXT,
  category VARCHAR(100),
  vendor VARCHAR(255),
  version VARCHAR(50),
  technology_stack TEXT[],
  status VARCHAR(50) DEFAULT 'production',
  criticality VARCHAR(20) DEFAULT 'medium',
  data_sensitivity VARCHAR(20) DEFAULT 'internal',
  users_count INTEGER,
  annual_cost DECIMAL(15, 2),
  currency VARCHAR(3) DEFAULT 'XAF',
  owner VARCHAR(255),
  technical_contact VARCHAR(255),
  documentation_url TEXT,
  go_live_date DATE,
  end_of_life_date DATE,
  replacement_project_id UUID REFERENCES sdsi_projects(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- KPIs (indicateurs de performance)
CREATE TABLE IF NOT EXISTS sdsi_kpis (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  axis_id UUID REFERENCES sdsi_strategic_axes(id) ON DELETE SET NULL,
  project_id UUID REFERENCES sdsi_projects(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  unit VARCHAR(50),
  target_value DECIMAL(15, 2),
  current_value DECIMAL(15, 2),
  baseline_value DECIMAL(15, 2),
  min_threshold DECIMAL(15, 2),
  max_threshold DECIMAL(15, 2),
  trend VARCHAR(20),
  frequency VARCHAR(50) DEFAULT 'monthly',
  data_source VARCHAR(255),
  calculation_method TEXT,
  responsible UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- KPI history (historique des KPIs)
CREATE TABLE IF NOT EXISTS sdsi_kpi_values (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kpi_id UUID REFERENCES sdsi_kpis(id) ON DELETE CASCADE,
  value DECIMAL(15, 2) NOT NULL,
  recorded_at DATE NOT NULL,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Risks register (registre des risques)
CREATE TABLE IF NOT EXISTS sdsi_risks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id UUID REFERENCES sdsi_projects(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  probability VARCHAR(20) DEFAULT 'medium',
  impact VARCHAR(20) DEFAULT 'medium',
  score INTEGER,
  status VARCHAR(50) DEFAULT 'identified',
  mitigation_strategy TEXT,
  contingency_plan TEXT,
  owner UUID REFERENCES users(id),
  identified_date DATE DEFAULT CURRENT_DATE,
  review_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create SDSI indexes
CREATE INDEX IF NOT EXISTS idx_sdsi_axes_workspace ON sdsi_strategic_axes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_projects_workspace ON sdsi_projects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_projects_axis ON sdsi_projects(axis_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_phases_project ON sdsi_project_phases(project_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_milestones_project ON sdsi_milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_resources_workspace ON sdsi_resources(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_allocations_resource ON sdsi_resource_allocations(resource_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_allocations_project ON sdsi_resource_allocations(project_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_applications_workspace ON sdsi_applications(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_kpis_workspace ON sdsi_kpis(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_kpi_values_kpi ON sdsi_kpi_values(kpi_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_risks_workspace ON sdsi_risks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sdsi_risks_project ON sdsi_risks(project_id);

-- SDSI Project Expenses (dépenses par projet SDSI)
CREATE TABLE IF NOT EXISTS sdsi_project_expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES sdsi_projects(id) ON DELETE CASCADE,
  category VARCHAR(100),
  description TEXT NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  expense_date DATE DEFAULT CURRENT_DATE,
  vendor VARCHAR(255),
  invoice_number VARCHAR(100),
  notes TEXT,
  status VARCHAR(50) DEFAULT 'approved',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sdsi_project_expenses_project ON sdsi_project_expenses(project_id);

-- Function to update actual_budget when expenses change
CREATE OR REPLACE FUNCTION update_sdsi_project_actual_budget()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE sdsi_projects
    SET actual_budget = COALESCE((
      SELECT SUM(amount) FROM sdsi_project_expenses WHERE project_id = OLD.project_id
    ), 0),
    updated_at = NOW()
    WHERE id = OLD.project_id;
    RETURN OLD;
  ELSE
    UPDATE sdsi_projects
    SET actual_budget = COALESCE((
      SELECT SUM(amount) FROM sdsi_project_expenses WHERE project_id = NEW.project_id
    ), 0),
    updated_at = NOW()
    WHERE id = NEW.project_id;
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger for auto-update of actual_budget
DROP TRIGGER IF EXISTS trigger_update_sdsi_project_budget ON sdsi_project_expenses;
CREATE TRIGGER trigger_update_sdsi_project_budget
AFTER INSERT OR UPDATE OR DELETE ON sdsi_project_expenses
FOR EACH ROW EXECUTE FUNCTION update_sdsi_project_actual_budget();

-- ==========================================
-- USER MANAGEMENT & PERMISSIONS SYSTEM
-- ==========================================

-- Custom roles table (beyond basic admin/member)
CREATE TABLE IF NOT EXISTS workspace_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  color VARCHAR(7) DEFAULT '#6366f1',
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, name)
);

-- Permissions definition
CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Role permissions (which permissions each role has)
CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id UUID REFERENCES workspace_roles(id) ON DELETE CASCADE,
  permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(role_id, permission_id)
);

-- User custom role assignment (in addition to workspace_members.role)
CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id UUID REFERENCES workspace_roles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id),
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, workspace_id, role_id)
);

-- Board-level permissions (who can access which board)
CREATE TABLE IF NOT EXISTS board_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission_level VARCHAR(50) NOT NULL DEFAULT 'view',
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(board_id, user_id)
);

-- Project-level permissions (SDSI projects)
CREATE TABLE IF NOT EXISTS project_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES sdsi_projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission_level VARCHAR(50) NOT NULL DEFAULT 'view',
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, user_id)
);

-- User groups (for bulk permission management)
CREATE TABLE IF NOT EXISTS user_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  color VARCHAR(7) DEFAULT '#6366f1',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, name)
);

-- User group members
CREATE TABLE IF NOT EXISTS user_group_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(group_id, user_id)
);

-- Group permissions on boards
CREATE TABLE IF NOT EXISTS board_group_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
  group_id UUID REFERENCES user_groups(id) ON DELETE CASCADE,
  permission_level VARCHAR(50) NOT NULL DEFAULT 'view',
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(board_id, group_id)
);

-- Group permissions on projects
CREATE TABLE IF NOT EXISTS project_group_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES sdsi_projects(id) ON DELETE CASCADE,
  group_id UUID REFERENCES user_groups(id) ON DELETE CASCADE,
  permission_level VARCHAR(50) NOT NULL DEFAULT 'view',
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, group_id)
);

-- Audit log for permission changes
CREATE TABLE IF NOT EXISTS permission_audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  old_value JSONB,
  new_value JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for permissions
CREATE INDEX IF NOT EXISTS idx_workspace_roles_workspace ON workspace_roles(workspace_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_workspace ON user_roles(workspace_id);
CREATE INDEX IF NOT EXISTS idx_board_permissions_board ON board_permissions(board_id);
CREATE INDEX IF NOT EXISTS idx_board_permissions_user ON board_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_project_permissions_project ON project_permissions(project_id);
CREATE INDEX IF NOT EXISTS idx_project_permissions_user ON project_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_groups_workspace ON user_groups(workspace_id);
CREATE INDEX IF NOT EXISTS idx_user_group_members_group ON user_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_user_group_members_user ON user_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_permission_audit_workspace ON permission_audit_logs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_permission_audit_target ON permission_audit_logs(target_user_id);

-- Insert default permissions
INSERT INTO permissions (code, name, description, category) VALUES
  -- Workspace permissions
  ('workspace.view', 'Voir l''espace de travail', 'Permet de voir l''espace de travail', 'workspace'),
  ('workspace.edit', 'Modifier l''espace de travail', 'Permet de modifier les paramètres de l''espace', 'workspace'),
  ('workspace.delete', 'Supprimer l''espace de travail', 'Permet de supprimer l''espace de travail', 'workspace'),
  ('workspace.manage_members', 'Gérer les membres', 'Permet d''inviter et gérer les membres', 'workspace'),
  ('workspace.manage_roles', 'Gérer les rôles', 'Permet de créer et gérer les rôles', 'workspace'),
  
  -- Board permissions
  ('board.create', 'Créer des tableaux', 'Permet de créer de nouveaux tableaux', 'board'),
  ('board.view', 'Voir les tableaux', 'Permet de voir les tableaux', 'board'),
  ('board.edit', 'Modifier les tableaux', 'Permet de modifier les tableaux', 'board'),
  ('board.delete', 'Supprimer les tableaux', 'Permet de supprimer les tableaux', 'board'),
  ('board.manage_permissions', 'Gérer les permissions', 'Permet de gérer qui peut accéder au tableau', 'board'),
  
  -- Item permissions
  ('item.create', 'Créer des items', 'Permet de créer des items', 'item'),
  ('item.view', 'Voir les items', 'Permet de voir les items', 'item'),
  ('item.edit', 'Modifier les items', 'Permet de modifier les items', 'item'),
  ('item.delete', 'Supprimer les items', 'Permet de supprimer les items', 'item'),
  ('item.assign', 'Assigner des items', 'Permet d''assigner des items à des utilisateurs', 'item'),
  
  -- SDSI Project permissions
  ('project.create', 'Créer des projets SDSI', 'Permet de créer des projets', 'sdsi'),
  ('project.view', 'Voir les projets', 'Permet de voir les projets', 'sdsi'),
  ('project.edit', 'Modifier les projets', 'Permet de modifier les projets', 'sdsi'),
  ('project.delete', 'Supprimer les projets', 'Permet de supprimer les projets', 'sdsi'),
  ('project.manage_team', 'Gérer l''équipe projet', 'Permet de gérer les membres du projet', 'sdsi'),
  ('project.manage_phases', 'Gérer les phases', 'Permet de créer/modifier les phases', 'sdsi'),
  ('project.manage_milestones', 'Gérer les jalons', 'Permet de créer/modifier les jalons', 'sdsi'),
  ('project.manage_risks', 'Gérer les risques', 'Permet de créer/modifier les risques', 'sdsi'),
  ('project.manage_budget', 'Gérer le budget', 'Permet de gérer le budget du projet', 'sdsi'),
  
  -- Budget permissions
  ('budget.create', 'Créer des budgets', 'Permet de créer des budgets', 'budget'),
  ('budget.view', 'Voir les budgets', 'Permet de voir les budgets', 'budget'),
  ('budget.edit', 'Modifier les budgets', 'Permet de modifier les budgets', 'budget'),
  ('budget.delete', 'Supprimer les budgets', 'Permet de supprimer les budgets', 'budget'),
  ('budget.approve_expenses', 'Approuver les dépenses', 'Permet d''approuver les dépenses', 'budget'),
  
  -- KPI permissions
  ('kpi.create', 'Créer des KPIs', 'Permet de créer des indicateurs', 'kpi'),
  ('kpi.view', 'Voir les KPIs', 'Permet de voir les indicateurs', 'kpi'),
  ('kpi.edit', 'Modifier les KPIs', 'Permet de modifier les indicateurs', 'kpi'),
  ('kpi.delete', 'Supprimer les KPIs', 'Permet de supprimer les indicateurs', 'kpi'),
  
  -- Report permissions
  ('report.view', 'Voir les rapports', 'Permet de consulter les rapports', 'report'),
  ('report.export', 'Exporter les données', 'Permet d''exporter les données', 'report'),
  
  -- Admin permissions
  ('admin.view_audit', 'Voir l''audit', 'Permet de voir les logs d''audit', 'admin'),
  ('admin.manage_all', 'Administration complète', 'Accès complet d''administration', 'admin')
ON CONFLICT (code) DO NOTHING;
`;

async function runMigrations() {
  try {
    logger.info('Starting database migrations...');
    await db.query(migrations);
    logger.info('✅ Migrations completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
