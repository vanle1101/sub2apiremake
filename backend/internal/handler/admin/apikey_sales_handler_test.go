package admin

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func signedSalesRequest(t *testing.T, handler gin.HandlerFunc, body string) *httptest.ResponseRecorder {
	t.Helper()
	const secret = "test-sales-secret"
	t.Setenv("SUB2API_SALES_SECRET", secret)
	t.Setenv("SUB2API_SALES_ALLOWED_CIDRS", "192.0.2.1/32")
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "\n" + body))

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/sales", bytes.NewBufferString(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	ctx.Request.Header.Set("X-Sales-Timestamp", timestamp)
	ctx.Request.Header.Set("X-Sales-Signature", hex.EncodeToString(mac.Sum(nil)))
	handler(ctx)
	return recorder
}

func TestAPIKeySaleAvailabilityReturnsExactIntegerCapacity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewAdminAPIKeyHandler(&stubAdminService{})
	recorder := signedSalesRequest(t, handler.SaleAvailability, `{"group_id":34}`)

	require.Equal(t, http.StatusOK, recorder.Code)
	var payload struct {
		Data struct {
			AvailableTokens int64 `json:"available_tokens"`
			SuggestedTokens int64 `json:"suggested_tokens"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))
	require.Equal(t, int64(6_588_203), payload.Data.AvailableTokens)
	require.Equal(t, int64(6_588_000), payload.Data.SuggestedTokens)
}

func TestAPIKeySaleReserveReturnsStableCapacityConflictWithoutTargetKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewAdminAPIKeyHandler(&stubAdminService{})
	body := `{"external_reference":"grok-order-9","operation":"renew_key","group_id":34,"requested_tokens":10000000,"target_key":"sk-super-secret-renewal-key-123456","expires_at":"2030-01-01T00:00:00Z"}`
	recorder := signedSalesRequest(t, handler.ReserveSale, body)

	require.Equal(t, http.StatusConflict, recorder.Code)
	require.NotContains(t, recorder.Body.String(), "sk-super-secret-renewal-key")
	var payload struct {
		Reason   string            `json:"reason"`
		Metadata map[string]string `json:"metadata"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))
	require.Equal(t, "INSUFFICIENT_GROK_CAPACITY", payload.Reason)
	require.Equal(t, "6588203", payload.Metadata["available_tokens"])
	require.Equal(t, "6588000", payload.Metadata["suggested_tokens"])
}
