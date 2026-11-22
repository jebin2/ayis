package awscfg

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// fake points the SDK at a local server that answers with h, and shortens the
// policy so a test takes milliseconds.
func fake(t *testing.T, h http.HandlerFunc) aws.Config {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	t.Setenv("AYIS_AWS_ENDPOINT", srv.URL)
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIDTEST")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	t.Setenv("AWS_CONFIG_FILE", "/dev/null")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", "/dev/null")
	oldB, oldT := MaxBackoff, CallTimeout
	MaxBackoff, CallTimeout = 5*time.Millisecond, 2*time.Second
	t.Cleanup(func() { MaxBackoff, CallTimeout = oldB, oldT })
	cfg, err := New(context.Background(), "ap-south-1")
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

const param = `{"Parameter":{"Name":"/x","Value":"v"}}`

func get(cfg aws.Config) error {
	_, err := ssm.NewFromConfig(cfg).GetParameter(context.Background(), &ssm.GetParameterInput{Name: aws.String("/x")})
	return err
}

func TestThrottlingIsRetriedUntilItPasses(t *testing.T) {
	var n atomic.Int32
	cfg := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) <= 2 {
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"__type":"ThrottlingException","message":"Rate exceeded"}`)
			return
		}
		_, _ = io.WriteString(w, param)
	})
	if err := get(cfg); err != nil {
		t.Fatalf("a call throttled twice should succeed on the third try: %v", err)
	}
	if n.Load() != 3 {
		t.Errorf("%d requests, want 3", n.Load())
	}
}

func TestAFailingServiceIsTriedAttemptsTimesThenReported(t *testing.T) {
	var n atomic.Int32
	cfg := fake(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.WriteHeader(503)
		_, _ = io.WriteString(w, `{"__type":"ServiceUnavailable","message":"down"}`)
	})
	if err := get(cfg); err == nil {
		t.Fatal("an unavailable service must end in an error")
	}
	if int(n.Load()) != Attempts {
		t.Errorf("%d requests, want %d", n.Load(), Attempts)
	}
}

func TestAMistakeIsNotRetried(t *testing.T) {
	var n atomic.Int32
	cfg := fake(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.WriteHeader(400)
		_, _ = io.WriteString(w, `{"__type":"ParameterNotFound","message":"no"}`)
	})
	if err := get(cfg); err == nil || n.Load() != 1 {
		t.Errorf("a missing parameter is an answer, asked once: err=%v requests=%d", err, n.Load())
	}
}

func TestAHungCallEndsAtTheDeadline(t *testing.T) {
	release := make(chan struct{})
	cfg := fake(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	defer close(release)
	CallTimeout = 200 * time.Millisecond
	start := time.Now()
	err := get(cfg)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a hung call should end in a deadline, got %v", err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("took %s, the deadline is %s", took, CallTimeout)
	}
}

func TestTheCallersOwnDeadlineWins(t *testing.T) {
	cfg := fake(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = io.WriteString(w, param)
	})
	CallTimeout = 50 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := ssm.NewFromConfig(cfg).GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String("/x")}); err != nil {
		t.Errorf("a caller that set its own deadline is not cut short: %v", err)
	}
}

func TestABodyIsReadableAfterTheCallReturns(t *testing.T) {
	body := strings.Repeat("game index ", 100000)
	cfg := fake(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1100000")
		for i := 0; i < len(body); i += 4096 {
			_, _ = io.WriteString(w, body[i:min(i+4096, len(body))])
			w.(http.Flusher).Flush()
			time.Sleep(time.Millisecond)
		}
	})
	o, err := s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true }).
		GetObject(context.Background(), &s3.GetObjectInput{Bucket: aws.String("b"), Key: aws.String("steam/index.json")})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = o.Body.Close() }()
	b, err := io.ReadAll(o.Body)
	if err != nil || len(b) != len(body) {
		t.Fatalf("the body was cut off after the call returned: %d of %d bytes, %v", len(b), len(body), err)
	}
}
