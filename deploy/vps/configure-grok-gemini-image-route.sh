#!/usr/bin/env bash
set -euo pipefail

: "${GEMINI_IMAGE_API_KEY:?GEMINI_IMAGE_API_KEY is required}"

GROK_GROUP_ID="${GROK_GROUP_ID:-34}"
GEMINI_IMAGE_MODEL="${GEMINI_IMAGE_MODEL:-gemini-2.5-flash-image}"

cd "$(dirname "$0")"

docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-sub2api}" \
  -d "${POSTGRES_DB:-sub2api}" \
  -v ON_ERROR_STOP=1 \
  -v group_id="$GROK_GROUP_ID" \
  -v gemini_key="$GEMINI_IMAGE_API_KEY" \
  -v gemini_model="$GEMINI_IMAGE_MODEL" <<'SQL'
BEGIN;

SELECT 1 / CASE WHEN EXISTS (
  SELECT 1
  FROM groups
  WHERE id = :group_id
    AND deleted_at IS NULL
) THEN 1 ELSE 0 END AS group_exists;

UPDATE groups
SET platform = 'composite',
    allow_image_generation = TRUE,
    updated_at = NOW()
WHERE id = :group_id
  AND deleted_at IS NULL;

WITH existing AS (
  SELECT id
  FROM accounts
  WHERE name = 'Gemini Image Gateway'
    AND platform = 'openai'
    AND deleted_at IS NULL
  ORDER BY id
  LIMIT 1
),
updated AS (
  UPDATE accounts
  SET type = 'apikey',
      credentials = jsonb_build_object(
        'api_key', :'gemini_key',
        'base_url', 'https://generativelanguage.googleapis.com/v1beta/openai',
        'model_mapping', jsonb_build_object(
          'grok-imagine', :'gemini_model',
          'grok-imagine-image', :'gemini_model',
          'grok-imagine-image-quality', :'gemini_model',
          :'gemini_model', :'gemini_model'
        )
      ),
      status = 'active',
      schedulable = TRUE,
      error_message = NULL,
      updated_at = NOW()
  WHERE id IN (SELECT id FROM existing)
  RETURNING id
),
inserted AS (
  INSERT INTO accounts (
    name,
    platform,
    type,
    credentials,
    extra,
    concurrency,
    priority,
    status,
    schedulable
  )
  SELECT
    'Gemini Image Gateway',
    'openai',
    'apikey',
    jsonb_build_object(
      'api_key', :'gemini_key',
      'base_url', 'https://generativelanguage.googleapis.com/v1beta/openai',
      'model_mapping', jsonb_build_object(
        'grok-imagine', :'gemini_model',
        'grok-imagine-image', :'gemini_model',
        'grok-imagine-image-quality', :'gemini_model',
        :'gemini_model', :'gemini_model'
      )
    ),
    '{}'::jsonb,
    3,
    1,
    'active',
    TRUE
  WHERE NOT EXISTS (SELECT 1 FROM updated)
  RETURNING id
),
image_account AS (
  SELECT id FROM updated
  UNION ALL
  SELECT id FROM inserted
)
INSERT INTO account_groups (account_id, group_id)
SELECT id, :group_id
FROM image_account
ON CONFLICT (account_id, group_id) DO NOTHING;

INSERT INTO composite_model_routes (
  group_id,
  public_model,
  match_type,
  target_platform,
  upstream_model,
  endpoint,
  priority,
  enabled,
  notes
)
VALUES (
  :group_id,
  'grok-imagine',
  'prefix',
  'openai',
  :'gemini_model',
  'images',
  1,
  TRUE,
  'One-key image routing: Grok chat remains Grok; image generation uses Gemini'
)
ON CONFLICT (group_id, endpoint, match_type, public_model)
WHERE deleted_at IS NULL
DO UPDATE SET
  target_platform = EXCLUDED.target_platform,
  upstream_model = EXCLUDED.upstream_model,
  priority = EXCLUDED.priority,
  enabled = EXCLUDED.enabled,
  notes = EXCLUDED.notes,
  updated_at = NOW();

WITH image_account AS (
  SELECT id
  FROM accounts
  WHERE name = 'Gemini Image Gateway'
    AND platform = 'openai'
    AND deleted_at IS NULL
  ORDER BY id
  LIMIT 1
)
INSERT INTO scheduler_outbox (event_type, account_id, group_id, payload)
SELECT event_type, account_id, group_id, '{}'::jsonb
FROM image_account
CROSS JOIN LATERAL (
  VALUES
    ('account_changed'::text, image_account.id, NULL::bigint),
    ('account_groups_changed'::text, image_account.id, :group_id::bigint)
) AS events(event_type, account_id, group_id);

INSERT INTO scheduler_outbox (event_type, account_id, group_id, payload)
VALUES
  ('group_changed', NULL, :group_id, '{}'::jsonb),
  ('full_rebuild', NULL, NULL, '{}'::jsonb);

COMMIT;
SQL

echo "Configured group ${GROK_GROUP_ID}: Grok text + Gemini image (${GEMINI_IMAGE_MODEL})"
