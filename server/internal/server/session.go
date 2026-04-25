package server

import (
	"errors"
	"sync"
)

// NotificationSender writes one server-push notification on the
// session's connection. The implementation is responsible for
// serialising concurrent writes (a request reply may be in flight
// at the same time a watcher event tries to push).
type NotificationSender func(method string, params interface{}) error

// Session is the per-connection state used by method handlers.
// Every accepted connection gets its own Session, so mutation of
// `authenticated` / `subscriptions` does not need to be locked across
// sessions. A single session can, however, race its own read loop
// against timers / push notifications, so the exported accessors
// take the session-local lock.
type Session struct {
	mu              sync.Mutex
	authenticated   bool
	subscriptionIDs map[string]struct{}
	sender          NotificationSender
}

// NewSession returns a fresh, unauthenticated session.
func NewSession() *Session {
	return &Session{subscriptionIDs: map[string]struct{}{}}
}

// IsAuthenticated reports whether auth has been accepted on this session.
func (s *Session) IsAuthenticated() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.authenticated
}

// MarkAuthenticated transitions the session to the authenticated state.
// Subsequent calls are no-ops.
func (s *Session) MarkAuthenticated() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.authenticated = true
}

// AddSubscription records that the session is watching a path.
func (s *Session) AddSubscription(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subscriptionIDs[id] = struct{}{}
}

// RemoveSubscription drops a subscription and returns whether it was
// present (useful for `fs.unwatch` when the id is unknown).
func (s *Session) RemoveSubscription(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.subscriptionIDs[id]
	delete(s.subscriptionIDs, id)
	return ok
}

// SubscriptionIDs returns a snapshot of the session's current subscriptions.
func (s *Session) SubscriptionIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.subscriptionIDs))
	for id := range s.subscriptionIDs {
		out = append(out, id)
	}
	return out
}

// SetNotifier installs the function the session uses to write a
// server-push frame. Called once at connection setup; later calls
// replace the previous sender atomically.
func (s *Session) SetNotifier(send NotificationSender) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sender = send
}

// SendNotification writes one notification frame on the session's
// connection. Returns an error when no notifier has been set (the
// session was constructed in test code without one) or the underlying
// write fails.
func (s *Session) SendNotification(method string, params interface{}) error {
	s.mu.Lock()
	send := s.sender
	s.mu.Unlock()
	if send == nil {
		return errors.New("Session: SendNotification called before SetNotifier")
	}
	return send(method, params)
}
