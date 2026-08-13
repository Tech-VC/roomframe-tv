export const claimGithubUpdateCheck = async (queryable, sourceKey) => {
  if (!sourceKey) return null;
  const result = await queryable.query(
    `UPDATE update_poll_state
     SET manual_status = 'running',
         manual_started_at = now(),
         manual_completed_at = NULL,
         manual_result = NULL,
         manual_error_code = NULL,
         updated_at = now()
     WHERE source_key = $1
       AND manual_request_id IS NOT NULL
       AND manual_status IN ('pending', 'running')
     RETURNING manual_request_id, manual_requested_at`,
    [sourceKey],
  );
  const row = result.rows[0];
  return row ? {
    id: row.manual_request_id,
    requestedAt: row.manual_requested_at,
  } : null;
};

export const completeGithubUpdateCheck = async (
  queryable,
  sourceKey,
  requestId,
  { status, result, errorCode = null },
) => {
  const completed = await queryable.query(
    `UPDATE update_poll_state
     SET manual_status = $3,
         manual_completed_at = now(),
         manual_result = $4,
         manual_error_code = $5,
         updated_at = now()
     WHERE source_key = $1
       AND manual_request_id = $2
       AND manual_status = 'running'
     RETURNING manual_request_id`,
    [sourceKey, requestId, status, result, errorCode],
  );
  return completed.rowCount === 1;
};
