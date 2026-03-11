package migrations

import "embed"

// FS holds all migration files baked into the binary at compile time.
// The //go:embed directive pulls in every .sql file in this directory.
//
//go:embed *.sql
var FS embed.FS
