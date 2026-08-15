-- Agent scheduled tasks created before this release were pinned to
-- `skip-missed`, so a fire missed while the app was closed was dropped
-- forever. Lift existing rows onto the same `after-startup` policy new tasks
-- are created with; other job types keep whatever policy they registered.
UPDATE `job_schedule`
SET `catch_up_policy` = '{"kind":"after-startup","minutes":1}'
WHERE `type` = 'agent.task'
  AND json_extract(`catch_up_policy`, '$.kind') = 'skip-missed';
