package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

const (
	APIKeySaleNew   = "new_key"
	APIKeySaleRenew = "renew_key"
)

func (s *adminServiceImpl) AdminLookupAPIKeySale(ctx context.Context, targetKey string) (*APIKey, error) {
	targetKey = strings.TrimSpace(targetKey)
	if len(targetKey) < 16 || len(targetKey) > MaxAPIKeyCredentialBytes {
		return nil, infraerrors.BadRequest("INVALID_TARGET_KEY", "target_key is invalid")
	}
	key, err := s.apiKeyRepo.GetByKey(ctx, targetKey)
	if err != nil || key == nil || key.Quota <= 0 {
		return nil, infraerrors.NotFound("API_KEY_NOT_RENEWABLE", "API key was not found or has unlimited quota")
	}
	return key, nil
}

type APIKeySaleFulfillmentInput struct {
	IdempotencyKey string
	Operation      string
	UserID         int64
	GroupID        int64
	QuotaDelta     float64
	Name           string
	TargetKey      string
}

type APIKeySaleFulfillmentResult struct {
	APIKey     *APIKey
	Idempotent bool
	Operation  string
}

type apiKeySalesRepository interface {
	FulfillAPIKeySale(ctx context.Context, input APIKeySaleFulfillmentInput, generatedKey string, requestFingerprint string) (*APIKeySaleFulfillmentResult, error)
}

func apiKeySaleFingerprint(input APIKeySaleFulfillmentInput) string {
	targetHash := sha256.Sum256([]byte(strings.TrimSpace(input.TargetKey)))
	payload, _ := json.Marshal(struct {
		Operation  string  `json:"operation"`
		UserID     int64   `json:"user_id"`
		GroupID    int64   `json:"group_id"`
		QuotaDelta float64 `json:"quota_delta"`
		TargetHash string  `json:"target_hash"`
	}{input.Operation, input.UserID, input.GroupID, input.QuotaDelta, hex.EncodeToString(targetHash[:])})
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func generateSalesAPIKey() (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return "sk-" + hex.EncodeToString(random), nil
}

func validateAPIKeySaleInput(input *APIKeySaleFulfillmentInput) error {
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	input.Operation = strings.TrimSpace(input.Operation)
	input.Name = strings.TrimSpace(input.Name)
	input.TargetKey = strings.TrimSpace(input.TargetKey)
	if input.IdempotencyKey == "" || len(input.IdempotencyKey) > 128 {
		return infraerrors.BadRequest("INVALID_IDEMPOTENCY_KEY", "a valid Idempotency-Key is required")
	}
	if input.Operation != APIKeySaleNew && input.Operation != APIKeySaleRenew {
		return infraerrors.BadRequest("INVALID_SALE_OPERATION", "operation must be new_key or renew_key")
	}
	if math.IsNaN(input.QuotaDelta) || math.IsInf(input.QuotaDelta, 0) || input.QuotaDelta <= 0 || input.QuotaDelta > 1_000_000 {
		return infraerrors.BadRequest("INVALID_QUOTA_DELTA", "quota_delta must be finite and positive")
	}
	if input.Operation == APIKeySaleNew {
		if input.UserID <= 0 || input.GroupID <= 0 {
			return infraerrors.BadRequest("INVALID_SALE_OWNER", "user_id and group_id are required for new keys")
		}
		if input.Name == "" {
			input.Name = "Telegram Grok API"
		}
		if len(input.Name) > 100 {
			return infraerrors.BadRequest("INVALID_KEY_NAME", "name is too long")
		}
	} else if len(input.TargetKey) < 16 || len(input.TargetKey) > MaxAPIKeyCredentialBytes {
		return infraerrors.BadRequest("INVALID_TARGET_KEY", "target_key is invalid")
	}
	return nil
}

func (s *adminServiceImpl) AdminFulfillAPIKeySale(ctx context.Context, input APIKeySaleFulfillmentInput) (*APIKeySaleFulfillmentResult, error) {
	if err := validateAPIKeySaleInput(&input); err != nil {
		return nil, err
	}
	repo, ok := s.apiKeyRepo.(apiKeySalesRepository)
	if !ok {
		return nil, infraerrors.InternalServer("API_KEY_SALES_UNAVAILABLE", "API key sales repository is unavailable")
	}
	generatedKey := ""
	if input.Operation == APIKeySaleNew {
		var err error
		generatedKey, err = generateSalesAPIKey()
		if err != nil {
			return nil, infraerrors.InternalServer("API_KEY_GENERATION_FAILED", "could not generate API key")
		}
	}
	result, err := repo.FulfillAPIKeySale(ctx, input, generatedKey, apiKeySaleFingerprint(input))
	if err != nil {
		return nil, err
	}
	if result != nil && result.APIKey != nil && s.authCacheInvalidator != nil {
		s.authCacheInvalidator.InvalidateAuthCacheByKey(ctx, result.APIKey.Key)
	}
	return result, nil
}
