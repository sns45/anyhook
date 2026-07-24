package core

import "strings"

// Subscribes reports whether an endpoint subscribes to an event type.
// Supports exact match, the "*" wildcard, and dot-prefixed wildcards such as
// "payment.*" (matches "payment.succeeded").
func Subscribes(endpoint Endpoint, eventType string) bool {
	for _, pattern := range endpoint.EventTypes {
		if pattern == "*" || pattern == eventType {
			return true
		}
		if strings.HasSuffix(pattern, ".*") {
			prefix := pattern[:len(pattern)-1] // keep the trailing dot: "payment."
			if strings.HasPrefix(eventType, prefix) {
				return true
			}
		}
	}
	return false
}

// Fanout fans an accepted event out to one INDEPENDENT message per matching,
// enabled endpoint. Disabled endpoints and non-subscribers are skipped.
// len(result) is the message count (0 is valid).
func Fanout(event SendEvent, eventID string, endpoints []Endpoint, rng Rng, now int64) []Message {
	messages := make([]Message, 0, len(endpoints))
	for _, e := range endpoints {
		if e.Disabled || !Subscribes(e, event.Type) {
			continue
		}
		messages = append(messages, Message{
			MessageID:  NewID("msg", rng),
			Tenant:     event.Tenant,
			EndpointID: e.EndpointID,
			EventID:    eventID,
			EventType:  event.Type,
			Payload:    event.Payload,
			AttemptNo:  0,
			Status:     StatusPending,
			CreatedAt:  now,
		})
	}
	return messages
}
