package migrate

import (
    "errors"
    "fmt"
    "io/fs"
    "log"
    "strings"
    "github.com/golang-migrate/migrate/v4"
    _ "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
)

func Up(dsn string, migrations fs.FS, serviceName string) error {
    source, err := iofs.New(migrations, ".")
    if err != nil {
        return fmt.Errorf("migrate source: %w", err)
    }
    // Use a service-specific migrations table so services with different
    // migration counts don't clobber each other's schema_migrations row.
    tableParam := "schema_migrations_" + serviceName
    dsnWithTable := dsn + "?x-migrations-table=" + tableParam
    if strings.Contains(dsn, "?") {
        dsnWithTable = dsn + "&x-migrations-table=" + tableParam
    }
    m, err := migrate.NewWithSourceInstance("iofs", source, dsnWithTable)
    if err != nil {
        return fmt.Errorf("migrate init: %w", err)
    }
    defer m.Close()
    if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
        return fmt.Errorf("migrate up: %w", err)
    }
    version, _, err := m.Version()
    if err != nil {
        log.Printf("warning: could not retrieve migration version: %v", err)
    } else {
        log.Printf("migrations up to date at version %d", version)
    }
    return nil
}
