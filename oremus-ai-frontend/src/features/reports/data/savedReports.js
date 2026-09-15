// Mock data for the secondary report tabs (Custom, Management, Drafts,
// Published, Archived, etc.). These don't have generators — they reference
// existing standard reports as their "base" and add metadata.

export const CUSTOM_REPORTS = [
  { id: 'cr-1', name: 'April Board Pack',           base: 'Profit and Loss',          createdBy: 'Maya Chen',  createdAt: '2026-04-30', modifiedAt: '2026-04-30', shared: 'Shared with team' },
  { id: 'cr-2', name: 'Marketing Spend Audit',      base: 'Expenses by Vendor Summary', createdBy: 'Diego Mora', createdAt: '2026-04-15', modifiedAt: '2026-04-22', shared: 'Private' },
  { id: 'cr-3', name: 'Cohort Revenue Analysis',    base: 'Sales by Customer Summary', createdBy: 'Sara Park',  createdAt: '2026-04-08', modifiedAt: '2026-04-21', shared: 'Shared with team' },
  { id: 'cr-4', name: 'Headcount Cost by Function', base: 'Profit and Loss Detail',   createdBy: 'Maya Chen',  createdAt: '2026-03-28', modifiedAt: '2026-04-18', shared: 'Private' },
  { id: 'cr-5', name: 'Working Capital Watchlist',  base: 'Balance Sheet Summary',    createdBy: 'Diego Mora', createdAt: '2026-03-12', modifiedAt: '2026-04-12', shared: 'Shared with team' },
];

export const MANAGEMENT_PACKS = [
  {
    id: 'mp-1',
    name: 'Company Overview',
    desc: 'Executive-ready overview: P&L, Balance Sheet, Cash Flow, and key receivables.',
    cadence: 'Monthly',
    lastRun: '2026-04-30',
    reports: ['Profit and Loss', 'Balance Sheet', 'Statement of Cash Flows', 'A/R Aging Summary'],
  },
  {
    id: 'mp-2',
    name: 'Sales Performance',
    desc: 'Pipeline, billings, and customer performance bundle.',
    cadence: 'Weekly',
    lastRun: '2026-04-29',
    reports: ['Sales by Customer Summary', 'Sales by Product/Service Summary', 'Income by Customer Summary', 'A/R Aging Summary'],
  },
  {
    id: 'mp-3',
    name: 'Expense & Vendor Performance',
    desc: 'Spend concentration, vendor health, and unpaid bills.',
    cadence: 'Monthly',
    lastRun: '2026-04-30',
    reports: ['Expenses by Vendor Summary', 'Unpaid Bills', 'A/P Aging Summary', 'Vendor Balance Summary'],
  },
  {
    id: 'mp-4',
    name: 'Custom Management Pack',
    desc: 'Build your own pack of saved customizations.',
    cadence: 'Ad-hoc',
    lastRun: null,
    reports: [],
  },
];

export const CASH_FLOW_OVERVIEW = {
  cashOnHand: 1_204_000,
  in30Days:    +312_000,
  out30Days:   -188_000,
  endingCash:  1_328_000,
  weeks: [
    { wk: 'W18', inflow:  84_000, outflow:  62_000 },
    { wk: 'W19', inflow:  96_000, outflow:  58_000 },
    { wk: 'W20', inflow:  68_000, outflow:  41_000 },
    { wk: 'W21', inflow:  72_000, outflow:  46_000 },
    { wk: 'W22', inflow:  88_000, outflow:  52_000 },
    { wk: 'W23', inflow: 104_000, outflow:  61_000 },
  ],
};

export const CASH_FLOW_SCENARIOS = [
  { id: 'base',         label: 'Base case',           endingCash: 1_328_000, runwayMonths: 14.2 },
  { id: 'optimistic',   label: 'Optimistic (+15%)',   endingCash: 1_512_000, runwayMonths: 16.8 },
  { id: 'conservative', label: 'Conservative (-15%)', endingCash: 1_144_000, runwayMonths: 11.4 },
];

export const DRAFT_REPORTS = [
  { id: 'dr-1', name: 'Q2 Board Pack - Draft',         author: 'Maya Chen',  modifiedAt: '2026-04-29', based: 'Profit and Loss' },
  { id: 'dr-2', name: 'Investor Update - April',        author: 'Sara Park',  modifiedAt: '2026-04-27', based: 'Executive Summary' },
  { id: 'dr-3', name: 'Capex Plan - Working Draft',     author: 'Diego Mora', modifiedAt: '2026-04-21', based: 'Cash Flow Statement' },
];

export const PUBLISHED_REPORTS = [
  { id: 'pr-1', name: 'March Management Accounts', publishedBy: 'Maya Chen',  publishedAt: '2026-04-04', recipients: 'Board + CFO',      version: 'v2' },
  { id: 'pr-2', name: 'Q1 FY26 P&L',               publishedBy: 'Sara Park',  publishedAt: '2026-04-10', recipients: 'CEO + leadership', version: 'v1' },
  { id: 'pr-3', name: 'Tax filing pack - Q4',      publishedBy: 'Diego Mora', publishedAt: '2026-03-22', recipients: 'External advisor', version: 'v3' },
];

export const ARCHIVED_REPORTS = [
  { id: 'ar-1', name: 'FY25 Audit Pack',            archivedAt: '2026-02-18', author: 'Maya Chen',  originalDate: '2025-04-12' },
  { id: 'ar-2', name: 'Old client demo P&L',        archivedAt: '2026-01-30', author: 'Diego Mora', originalDate: '2024-11-08' },
  { id: 'ar-3', name: 'Legacy fixed-asset register', archivedAt: '2025-12-01', author: 'Sara Park',  originalDate: '2023-06-21' },
];
