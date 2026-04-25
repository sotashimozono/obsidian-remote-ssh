package server

import "sync"

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
