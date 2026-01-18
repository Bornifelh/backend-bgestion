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

-- Create indexes
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
