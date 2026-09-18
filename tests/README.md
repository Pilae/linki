# Enrollment regression tests

With the repository dependencies installed (`npm ci`):

```sh
node --test tests/enrollment.test.cjs
```

These tests execute the API handler with real in-memory SQLite databases and
synthetic targets. They do not start the application or contact LinkedIn.
Competing writes are injected between the preview reads and the immediate
transaction to exercise state and eligibility rechecks deterministically.
