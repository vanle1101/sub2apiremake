package admin

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

const maxAPIKeySaleBodyBytes = 16 * 1024

type apiKeySaleRequest struct {
	Operation  string  `json:"operation"`
	UserID     int64   `json:"user_id"`
	GroupID    int64   `json:"group_id"`
	QuotaDelta float64 `json:"quota_delta"`
	Name       string  `json:"name"`
	TargetKey  string  `json:"target_key"`
}

type apiKeySaleLookupRequest struct {
	TargetKey string `json:"target_key"`
}

type apiKeySaleResponse struct {
	Operation   string  `json:"operation"`
	Idempotent  bool    `json:"idempotent"`
	APIKeyID    int64   `json:"api_key_id"`
	Key         string  `json:"key,omitempty"`
	MaskedKey   string  `json:"masked_key"`
	Status      string  `json:"status"`
	QuotaLimit  float64 `json:"quota_limit"`
	QuotaUsed   float64 `json:"quota_used"`
	QuotaRemain float64 `json:"quota_remaining"`
}

func maskSalesAPIKey(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 12 {
		return "***"
	}
	return value[:7] + "..." + value[len(value)-5:]
}

func salesClientIPAllowed(rawIP, configured string) bool {
	ip := net.ParseIP(strings.TrimSpace(rawIP))
	if ip == nil || strings.TrimSpace(configured) == "" {
		return false
	}
	for _, rawRule := range strings.Split(configured, ",") {
		rule := strings.TrimSpace(rawRule)
		if rule == "" {
			continue
		}
		if allowedIP := net.ParseIP(rule); allowedIP != nil && allowedIP.Equal(ip) {
			return true
		}
		if _, network, err := net.ParseCIDR(rule); err == nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func verifyAPIKeySaleRequest(c *gin.Context, body []byte) bool {
	secret := strings.TrimSpace(os.Getenv("SUB2API_SALES_SECRET"))
	allowedCIDRs := strings.TrimSpace(os.Getenv("SUB2API_SALES_ALLOWED_CIDRS"))
	if secret == "" || allowedCIDRs == "" {
		response.ErrorWithDetails(c, http.StatusServiceUnavailable, "Internal API key sales are not configured", "API_KEY_SALES_NOT_CONFIGURED", nil)
		return false
	}
	if !salesClientIPAllowed(c.ClientIP(), allowedCIDRs) {
		response.ErrorWithDetails(c, http.StatusForbidden, "Source IP is not allowed", "API_KEY_SALES_IP_DENIED", nil)
		return false
	}
	timestampText := strings.TrimSpace(c.GetHeader("X-Sales-Timestamp"))
	timestamp, err := strconv.ParseInt(timestampText, 10, 64)
	if err != nil || time.Since(time.Unix(timestamp, 0)).Abs() > 5*time.Minute {
		response.ErrorWithDetails(c, http.StatusUnauthorized, "Request timestamp is invalid", "INVALID_SALES_TIMESTAMP", nil)
		return false
	}
	provided, err := hex.DecodeString(strings.TrimSpace(c.GetHeader("X-Sales-Signature")))
	if err != nil {
		response.ErrorWithDetails(c, http.StatusUnauthorized, "Request signature is invalid", "INVALID_SALES_SIGNATURE", nil)
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestampText + "\n"))
	_, _ = mac.Write(body)
	expected := mac.Sum(nil)
	if len(provided) != len(expected) || subtle.ConstantTimeCompare(provided, expected) != 1 {
		response.ErrorWithDetails(c, http.StatusUnauthorized, "Request signature is invalid", "INVALID_SALES_SIGNATURE", nil)
		return false
	}
	return true
}

// FulfillSale atomically creates an API key or adds quota to an existing key.
// POST /api/v1/admin/api-keys/sales/fulfill
func (h *AdminAPIKeyHandler) FulfillSale(c *gin.Context) {
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxAPIKeySaleBodyBytes))
	if err != nil {
		response.BadRequest(c, "Request body is invalid")
		return
	}
	if !verifyAPIKeySaleRequest(c, body) {
		return
	}
	var req apiKeySaleRequest
	if err := json.Unmarshal(body, &req); err != nil {
		response.BadRequest(c, "Invalid request")
		return
	}
	result, err := h.adminService.AdminFulfillAPIKeySale(c.Request.Context(), service.APIKeySaleFulfillmentInput{
		IdempotencyKey: c.GetHeader("Idempotency-Key"),
		Operation:      req.Operation,
		UserID:         req.UserID,
		GroupID:        req.GroupID,
		QuotaDelta:     req.QuotaDelta,
		Name:           req.Name,
		TargetKey:      req.TargetKey,
	})
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	key := result.APIKey
	remaining := key.Quota - key.QuotaUsed
	if remaining < 0 {
		remaining = 0
	}
	payload := apiKeySaleResponse{
		Operation:   result.Operation,
		Idempotent:  result.Idempotent,
		APIKeyID:    key.ID,
		MaskedKey:   maskSalesAPIKey(key.Key),
		Status:      key.Status,
		QuotaLimit:  key.Quota,
		QuotaUsed:   key.QuotaUsed,
		QuotaRemain: remaining,
	}
	if result.Operation == service.APIKeySaleNew {
		payload.Key = key.Key
	}
	response.Success(c, payload)
}

// LookupSale validates a pasted key before the customer is asked to pay.
// POST /api/v1/admin/api-keys/sales/lookup
func (h *AdminAPIKeyHandler) LookupSale(c *gin.Context) {
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxAPIKeySaleBodyBytes))
	if err != nil {
		response.BadRequest(c, "Request body is invalid")
		return
	}
	if !verifyAPIKeySaleRequest(c, body) {
		return
	}
	var req apiKeySaleLookupRequest
	if err := json.Unmarshal(body, &req); err != nil {
		response.BadRequest(c, "Invalid request")
		return
	}
	key, err := h.adminService.AdminLookupAPIKeySale(c.Request.Context(), req.TargetKey)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	remaining := key.Quota - key.QuotaUsed
	if remaining < 0 {
		remaining = 0
	}
	response.Success(c, apiKeySaleResponse{
		APIKeyID: key.ID, MaskedKey: maskSalesAPIKey(key.Key), Status: key.Status,
		QuotaLimit: key.Quota, QuotaUsed: key.QuotaUsed, QuotaRemain: remaining,
	})
}
