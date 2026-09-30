export interface JiraConfig {
  baseUrl: string;
  pat: string;
  requestTimeoutMs?: number;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: string;
    status: {
      name: string;
      id: string;
    };
    priority?: {
      name: string;
      id: string;
    };
    assignee?: {
      displayName: string;
      emailAddress: string;
      name: string;
    };
    reporter?: {
      displayName: string;
      emailAddress: string;
      name: string;
    };
    created: string;
    updated: string;
    issuetype: {
      name: string;
      id: string;
    };
    project: {
      key: string;
      name: string;
    };
    labels?: string[];
    components?: Array<{ name: string }>;
    fixVersions?: Array<{ name: string }>;
    [key: string]: unknown;
  };
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  self: string;
  projectTypeKey: string;
  lead?: {
    displayName: string;
    name: string;
  };
}

export interface JiraComment {
  id: string;
  self: string;
  body: string;
  author: {
    displayName: string;
    name: string;
  };
  created: string;
  updated: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: {
    id: string;
    name: string;
  };
  hasScreen?: boolean;
  fields?: Record<string, RawFieldMeta>;
}

export interface JiraSearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

export interface JiraUser {
  self: string;
  key: string;
  name: string;
  emailAddress: string;
  displayName: string;
  active: boolean;
}

export interface JiraCreateIssueResponse {
  id: string;
  key: string;
  self: string;
}

export interface JiraCreateIssueRequest {
  fields: {
    project: { key: string };
    summary: string;
    description?: string;
    issuetype: { name: string };
    priority?: { name: string };
    assignee?: { name: string };
    labels?: string[];
    [key: string]: unknown;
  };
}

export interface JiraUpdateIssueRequest {
  fields: {
    summary?: string;
    description?: string;
    priority?: { name: string };
    assignee?: { name: string };
    labels?: string[];
    [key: string]: unknown;
  };
}

export interface FieldOption {
  id?: string;
  name?: string;
  value?: string;
  key?: string;
  label?: string;
  children?: FieldOption[];
  [key: string]: unknown;
}

export interface FieldSchema {
  type: string;
  items?: string;
  system?: string;
  custom?: string;
  customId?: number;
}

export interface RawFieldMeta {
  fieldId?: string;
  key?: string;
  name: string;
  required?: boolean;
  schema?: FieldSchema;
  allowedValues?: FieldOption[];
  defaultValue?: unknown;
  hasDefaultValue?: boolean;
}

export interface FieldMeta {
  fieldId: string;
  name: string;
  required: boolean;
  schema?: FieldSchema;
  hasDefaultValue: boolean;
  hasAllowedValues: boolean;
  allowedValues?: FieldOption[];
}

export interface CreateMetaResult {
  projectKey: string;
  metaSource: string;
  accurate: boolean;
  issueTypes: Array<{ id: string; name: string; fields: FieldMeta[] }>;
}
