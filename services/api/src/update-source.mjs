import crypto from 'node:crypto';

const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export const normalizeGithubRepository = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const repository = String(value).trim();
  if (
    !repositoryPattern.test(repository)
    || repository.includes('..')
    || repository.endsWith('.git')
  ) {
    throw new Error('invalid_github_update_repository');
  }
  return repository.toLowerCase();
};

export const normalizeUpdateChannel = (value) => {
  const channel = String(value ?? 'stable').trim().toLowerCase();
  if (!['stable', 'preview'].includes(channel)) {
    throw new Error('invalid_update_channel');
  }
  return channel;
};

export const releaseSourceKey = (repository, channel) => {
  if (!repository) return null;
  return `github:${crypto
    .createHash('sha256')
    .update(`${repository}\0${channel}`)
    .digest('hex')}`;
};

export const serializeGithubUpdateCheck = (state) => (
  state?.manual_request_id
    ? {
        id: state.manual_request_id,
        status: state.manual_status,
        requestedAt: state.manual_requested_at,
        startedAt: state.manual_started_at,
        completedAt: state.manual_completed_at,
        result: state.manual_result,
        errorCode: state.manual_error_code,
      }
    : null
);

export const serializeReleaseSource = (config, state = null) => ({
  provider: 'github',
  enabled: Boolean(config.updateGithubRepository),
  repository: config.updateGithubRepository,
  channel: config.updateGithubChannel,
  pollIntervalMinutes: config.updatePollMinutes,
  state: state ? {
    lastCheckedAt: state.last_checked_at,
    lastSuccessAt: state.last_success_at,
    lastResult: state.last_result,
    lastErrorCode: state.last_error_code,
    externalReleaseId: state.external_release_id === null
      ? null
      : Number(state.external_release_id),
    externalAssetId: state.external_asset_id === null
      ? null
      : Number(state.external_asset_id),
    importedReleaseId: state.imported_release_id,
    manualCheck: serializeGithubUpdateCheck(state),
  } : null,
});
