package aws

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/aws/aws-lambda-go/events"

	"github.com/sns45/anyhook/go/core"
)

// tenantHeader is the trusted header carrying the caller's tenant id.
// Like the TS ingest handler (handlers.ts), anyhook does NOT authenticate end
// customers here (G8): mount this behind the producer's own auth, which must
// set this header (e.g. via a Lambda authorizer or an upstream auth-gateway).
const tenantHeader = "x-anyhook-tenant"

// NewDeliverHandler builds the SQS event-source Lambda handler: one
// invocation per batch. Each record drives one engine delivery attempt via
// SqsTransport.DispatchRecords; a failing record is reported through
// BatchItemFailures so only it is redelivered (requires
// FunctionResponseTypes: ReportBatchItemFailures configured on the event
// source mapping). Mirrors TS createDeliverHandler.
func NewDeliverHandler(env Env, opts AdapterOptions) func(ctx context.Context, event events.SQSEvent) (events.SQSEventResponse, error) {
	engine, adapter := BuildEngine(env, opts)
	return func(ctx context.Context, event events.SQSEvent) (events.SQSEventResponse, error) {
		return adapter.Transport.DispatchRecords(ctx, event, engine.ProcessMessage)
	}
}

// NewSweeperHandler builds the scheduled (EventBridge, fixed 60s rate per
// D2/ADR-0001) Lambda handler: sweeps due SCHED# rows and enqueues them to
// SQS. Mirrors TS createSweeperHandler.
func NewSweeperHandler(env Env) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		_, err := RunSweeper(ctx, env, timeNowMs())
		return err
	}
}

// ingestRequest is the JSON body NewIngestHandler expects.
type ingestRequest struct {
	Type           string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
	IdempotencyKey string          `json:"idempotencyKey"`
}

// NewIngestHandler builds the API Gateway (HTTP API, payload format 2.0)
// ingest Lambda handler: parses the JSON request body and calls Engine.Send.
//
// The TS ingest handler (handlers.ts) mounts core's framework-agnostic
// createPortalRouter, which also serves endpoint CRUD and the delivery-log
// query surface; that portal router has not been ported to go/core (only the
// engine's own Send/ProcessMessage surface has), so this handler covers just
// the send path -- the one every producer integration needs -- rather than
// the full portal. See the task report for this scope note.
func NewIngestHandler(env Env, opts AdapterOptions) func(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	engine, _ := BuildEngine(env, opts)
	return func(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
		tenant := req.Headers[tenantHeader]
		if tenant == "" {
			return jsonResponse(401, map[string]string{"error": "missing " + tenantHeader + " header"}), nil
		}

		raw := []byte(req.Body)
		if req.IsBase64Encoded {
			decoded, err := base64.StdEncoding.DecodeString(req.Body)
			if err != nil {
				return jsonResponse(400, map[string]string{"error": "invalid base64 body"}), nil
			}
			raw = decoded
		}

		var body ingestRequest
		if err := json.Unmarshal(raw, &body); err != nil {
			return jsonResponse(400, map[string]string{"error": "invalid JSON body"}), nil
		}

		receipt, err := engine.Send(ctx, core.SendEvent{
			Type: body.Type, Tenant: tenant, Payload: body.Payload, IdempotencyKey: body.IdempotencyKey,
		})
		if err != nil {
			return jsonResponse(400, map[string]string{"error": err.Error()}), nil
		}
		return jsonResponse(202, receipt), nil
	}
}

func jsonResponse(status int, v any) events.APIGatewayV2HTTPResponse {
	body, err := json.Marshal(v)
	if err != nil {
		return events.APIGatewayV2HTTPResponse{StatusCode: 500, Body: fmt.Sprintf(`{"error":%q}`, err.Error())}
	}
	return events.APIGatewayV2HTTPResponse{
		StatusCode: status,
		Headers:    map[string]string{"content-type": "application/json"},
		Body:       string(body),
	}
}
