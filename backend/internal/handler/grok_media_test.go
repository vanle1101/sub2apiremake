package handler

import (
	"context"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

type grokMediaEligibilityProberStub struct {
	eligible bool
	reason   string
	err      error
	calls    int
}

func (s *grokMediaEligibilityProberStub) ProbeMediaEligibility(context.Context, int64) (bool, string, error) {
	s.calls++
	return s.eligible, s.reason, s.err
}

func TestShouldRecordGrokMediaUsage(t *testing.T) {
	tests := []struct {
		name     string
		endpoint service.GrokMediaEndpoint
		model    string
		want     bool
	}{
		{
			name:     "image generation records usage",
			endpoint: service.GrokMediaEndpointImagesGenerations,
			model:    "grok-imagine",
			want:     true,
		},
		{
			name:     "image edit records usage",
			endpoint: service.GrokMediaEndpointImagesEdits,
			model:    "grok-imagine-edit",
			want:     true,
		},
		{
			name:     "video generation defers usage until status",
			endpoint: service.GrokMediaEndpointVideosGenerations,
			model:    "grok-imagine-video-1.5",
			want:     false,
		},
		{
			name:     "video status skips immediate helper (status path claims separately)",
			endpoint: service.GrokMediaEndpointVideoStatus,
			model:    "",
			want:     false,
		},
		{
			name:     "video content skips usage",
			endpoint: service.GrokMediaEndpointVideoContent,
			model:    "",
			want:     false,
		},
		{
			name:     "generation skips usage without model",
			endpoint: service.GrokMediaEndpointImagesGenerations,
			model:    " ",
			want:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Nil result must never bill.
			require.False(t, shouldRecordGrokMediaUsage(tt.endpoint, tt.model, nil))
			// Immediate helper only bills image generation (async video bills on status).
			result := &service.OpenAIForwardResult{ImageCount: 1, VideoCount: 0}
			if tt.endpoint.IsGenerationRequest() && !isGrokVideoCreateEndpoint(tt.endpoint) && strings.TrimSpace(tt.model) != "" {
				require.Equal(t, tt.want, shouldRecordGrokMediaUsage(tt.endpoint, tt.model, result))
			} else {
				require.False(t, shouldRecordGrokMediaUsage(tt.endpoint, tt.model, result))
			}
			// Zero billable units never bill even for generation + model.
			empty := &service.OpenAIForwardResult{}
			require.False(t, shouldRecordGrokMediaUsage(tt.endpoint, tt.model, empty))
		})
	}
}

func TestGrokMediaRequiredCapability(t *testing.T) {
	tests := []struct {
		name     string
		endpoint service.GrokMediaEndpoint
		want     service.OpenAIEndpointCapability
	}{
		{name: "image generation", endpoint: service.GrokMediaEndpointImagesGenerations, want: service.OpenAIEndpointCapabilityGrokMediaGeneration},
		{name: "image edit", endpoint: service.GrokMediaEndpointImagesEdits, want: service.OpenAIEndpointCapabilityGrokMediaGeneration},
		{name: "video generation", endpoint: service.GrokMediaEndpointVideosGenerations, want: service.OpenAIEndpointCapabilityGrokMediaGeneration},
		{name: "video edit", endpoint: service.GrokMediaEndpointVideosEdits, want: service.OpenAIEndpointCapabilityGrokMediaGeneration},
		{name: "video extension", endpoint: service.GrokMediaEndpointVideosExtensions, want: service.OpenAIEndpointCapabilityGrokMediaGeneration},
		{name: "video status preserves lookup", endpoint: service.GrokMediaEndpointVideoStatus, want: ""},
		{name: "video content preserves lookup", endpoint: service.GrokMediaEndpointVideoContent, want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, grokMediaRequiredCapability(tt.endpoint))
		})
	}
}

func TestGrokMediaScheduleModelUsesNormalizedMappedUpstream(t *testing.T) {
	account := &service.Account{
		Platform: service.PlatformGrok,
		Credentials: map[string]any{
			"model_mapping": map[string]any{
				"grok-imagine-video-1.5": "wrong-raw-model",
				"grok-imagine-video":     "mapped-video-model",
			},
		},
	}

	require.Equal(t, "mapped-video-model", grokMediaScheduleModel(account, "grok-imagine-video", nil))
	require.Equal(t, "actual-upstream-model", grokMediaScheduleModel(account, "grok-imagine-video", &service.OpenAIForwardResult{
		UpstreamModel: "actual-upstream-model",
	}))
	require.Equal(t, "mapped-video-model", grokMediaScheduleModel(account, "grok-imagine-video", &service.OpenAIForwardResult{}))
	require.Equal(t, "grok-imagine-video", grokMediaScheduleModel(nil, " grok-imagine-video ", nil))
}

func TestEnsureGrokMediaAccountEligibility(t *testing.T) {
	t.Run("api key account is scheduled for upstream capability check", func(t *testing.T) {
		prober := &grokMediaEligibilityProberStub{}
		h := &OpenAIGatewayHandler{grokMediaEligibilityProber: prober}
		account := &service.Account{Platform: service.PlatformGrok, Type: service.AccountTypeAPIKey}

		eligible, reason, err := h.ensureGrokMediaAccountEligibility(context.Background(), account)

		require.NoError(t, err)
		require.True(t, eligible)
		require.Equal(t, "upstream_capability_check", reason)
		require.Zero(t, prober.calls)
	})

	t.Run("unobserved oauth reaches media endpoint without billing probe", func(t *testing.T) {
		prober := &grokMediaEligibilityProberStub{eligible: true, reason: "eligible"}
		h := &OpenAIGatewayHandler{grokMediaEligibilityProber: prober}
		account := &service.Account{ID: 7, Platform: service.PlatformGrok, Type: service.AccountTypeOAuth}

		eligible, reason, err := h.ensureGrokMediaAccountEligibility(context.Background(), account)

		require.NoError(t, err)
		require.True(t, eligible)
		require.Equal(t, "upstream_capability_check", reason)
		require.Zero(t, prober.calls)
	})

	t.Run("missing prober does not block media", func(t *testing.T) {
		h := &OpenAIGatewayHandler{}
		account := &service.Account{ID: 8, Platform: service.PlatformGrok, Type: service.AccountTypeOAuth}

		eligible, reason, err := h.ensureGrokMediaAccountEligibility(context.Background(), account)

		require.NoError(t, err)
		require.True(t, eligible)
		require.Equal(t, "upstream_capability_check", reason)
	})

	t.Run("explicit media disable remains enforced", func(t *testing.T) {
		prober := &grokMediaEligibilityProberStub{}
		h := &OpenAIGatewayHandler{grokMediaEligibilityProber: prober}
		account := &service.Account{ID: 9, Platform: service.PlatformGrok, Type: service.AccountTypeOAuth, Extra: map[string]any{service.GrokMediaEligibleExtraKey: false}}

		eligible, reason, err := h.ensureGrokMediaAccountEligibility(context.Background(), account)

		require.NoError(t, err)
		require.False(t, eligible)
		require.Equal(t, "override_disabled", reason)
		require.Zero(t, prober.calls)
	})
}
