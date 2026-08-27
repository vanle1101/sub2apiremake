package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

func scanSaleAPIKey(row *sql.Row) (*service.APIKey, error) {
	key := &service.APIKey{}
	err := row.Scan(&key.ID, &key.UserID, &key.Key, &key.Name, &key.GroupID, &key.Status, &key.Quota, &key.QuotaUsed, &key.CreatedAt, &key.UpdatedAt)
	return key, err
}

func (r *apiKeyRepository) FulfillAPIKeySale(ctx context.Context, input service.APIKeySaleFulfillmentInput, generatedKey string, requestFingerprint string) (*service.APIKeySaleFulfillmentResult, error) {
	if r.db == nil {
		return nil, infraerrors.InternalServer("API_KEY_SALES_UNAVAILABLE", "database transaction support is unavailable")
	}
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, fmt.Errorf("begin API key sale: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Serialize requests that carry the same idempotency key. Without this lock,
	// two concurrent webhook retries can both pass the lookup and one would fail
	// at the unique insert after doing otherwise valid work. The transaction lock
	// makes the second request observe and return the committed fulfillment.
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, input.IdempotencyKey); err != nil {
		return nil, fmt.Errorf("lock API key sale: %w", err)
	}

	var existingOperation, existingFingerprint string
	var existingKeyID int64
	err = tx.QueryRowContext(ctx, `
		SELECT operation, request_fingerprint, api_key_id
		FROM api_key_sales_fulfillments
		WHERE idempotency_key=$1
	`, input.IdempotencyKey).Scan(&existingOperation, &existingFingerprint, &existingKeyID)
	if err == nil {
		if existingOperation != input.Operation || existingFingerprint != requestFingerprint {
			return nil, infraerrors.Conflict("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with different sale data")
		}
		key, loadErr := scanSaleAPIKey(tx.QueryRowContext(ctx, `
			SELECT id, user_id, key, name, group_id, status, quota, quota_used, created_at, updated_at
			FROM api_keys WHERE id=$1 AND deleted_at IS NULL
		`, existingKeyID))
		if loadErr != nil {
			return nil, fmt.Errorf("reload fulfilled API key: %w", loadErr)
		}
		return &service.APIKeySaleFulfillmentResult{APIKey: key, Idempotent: true, Operation: input.Operation}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("lookup API key sale: %w", err)
	}

	var key *service.APIKey
	if input.Operation == service.APIKeySaleNew {
		var groupPlatform, groupStatus string
		if err := tx.QueryRowContext(ctx, "SELECT platform, status FROM groups WHERE id=$1", input.GroupID).Scan(&groupPlatform, &groupStatus); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, infraerrors.BadRequest("GROK_GROUP_NOT_FOUND", "target Grok group was not found")
			}
			return nil, fmt.Errorf("load target group: %w", err)
		}
		if groupPlatform != service.PlatformGrok || groupStatus != service.StatusActive {
			return nil, infraerrors.BadRequest("INVALID_GROK_GROUP", "target group must be an active Grok group")
		}
		key, err = scanSaleAPIKey(tx.QueryRowContext(ctx, `
			INSERT INTO api_keys (user_id, key, name, group_id, status, quota, quota_used, ip_whitelist, ip_blacklist, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, 0, '[]'::jsonb, '[]'::jsonb, NOW(), NOW())
			RETURNING id, user_id, key, name, group_id, status, quota, quota_used, created_at, updated_at
		`, input.UserID, generatedKey, input.Name, input.GroupID, service.StatusActive, input.QuotaDelta))
		if err != nil {
			return nil, fmt.Errorf("create sold API key: %w", err)
		}
	} else {
		key, err = scanSaleAPIKey(tx.QueryRowContext(ctx, `
			UPDATE api_keys
			SET quota=quota+$1,
			    status=CASE WHEN status=$2 THEN $3 ELSE status END,
			    updated_at=NOW()
			WHERE key=$4 AND deleted_at IS NULL AND quota>0
			RETURNING id, user_id, key, name, group_id, status, quota, quota_used, created_at, updated_at
		`, input.QuotaDelta, service.StatusAPIKeyQuotaExhausted, service.StatusActive, input.TargetKey))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, infraerrors.NotFound("API_KEY_NOT_RENEWABLE", "API key was not found or has unlimited quota")
		}
		if err != nil {
			return nil, fmt.Errorf("renew API key quota: %w", err)
		}
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO api_key_sales_fulfillments
		(idempotency_key, operation, request_fingerprint, api_key_id, quota_delta)
		VALUES ($1, $2, $3, $4, $5)
	`, input.IdempotencyKey, input.Operation, requestFingerprint, key.ID, input.QuotaDelta); err != nil {
		return nil, fmt.Errorf("record API key sale: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit API key sale: %w", err)
	}
	return &service.APIKeySaleFulfillmentResult{APIKey: key, Operation: input.Operation}, nil
}
