// Minimal replacement for @actions/core so the action can ship without node_modules.
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function getInput(name, { required = false, default: fallback = '' } = {}) {
  const value = process.env[`INPUT_${name.toUpperCase().replace(/ /g, '_')}`] ?? '';
  const trimmed = value.trim();
  if (!trimmed && required) {
    throw new Error(`Input "${name}" is required`);
  }
  return trimmed || fallback;
}

export function getBooleanInput(name, fallback) {
  const value = getInput(name).toLowerCase();
  if (!value) return fallback;
  if (['true', 'yes', '1'].includes(value)) return true;
  if (['false', 'no', '0'].includes(value)) return false;
  throw new Error(`Input "${name}" must be a boolean, got "${value}"`);
}

function writeFileCommand(envName, line) {
  const file = process.env[envName];
  if (!file) return;
  appendFileSync(file, `${line}\n`, 'utf8');
}

export function setOutput(name, value) {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  writeFileCommand('GITHUB_OUTPUT', `${name}<<${delimiter}\n${value}\n${delimiter}`);
}

export function summary(markdown) {
  writeFileCommand('GITHUB_STEP_SUMMARY', markdown);
}

export function maskSecret(value) {
  if (value) process.stdout.write(`::add-mask::${value}\n`);
}

export const info = (message) => process.stdout.write(`${message}\n`);
export const notice = (message) => process.stdout.write(`::notice::${message}\n`);
export const warn = (message) => process.stdout.write(`::warning::${message}\n`);
export const error = (message) => process.stdout.write(`::error::${message}\n`);

export function readEventPayload() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}
