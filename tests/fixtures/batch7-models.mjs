// Visible catalog, hidden model and model-specific effort bounds. No provider calls.
export default {
  fetched_at: '2026-10-18T00:00:00Z', etag: 'x', client_version: '0.163.0',
  models: [
    { slug: 'gpt-hidden', visibility: 'hide', priority: 0, supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-6-luna', display_name: 'Luna', visibility: 'list', priority: 4, default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort, description: effort })) },
    { slug: 'gpt-6.1-sol', display_name: 'Sol', visibility: 'list', priority: 1, default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort, description: effort })) },
  ],
}
