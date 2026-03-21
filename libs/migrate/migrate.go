// review-sweep
package migrate

import (
    "errors"
    "fmt"
    "io/fs"
    "log"

    "github.com/golang-migrate/migrate/v4"
    _ "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
)

func Up(dsn string, migrations fs.FS, dbName string) error {
    source, err := iofs.New(migrations, ".")
    if err != nil {
        return fmt.Errorf("migrate source: %w", err)
    }

    m, err := migrate.NewWithSourceInstance("iofs", source, dsn)
    if err != nil {
        return fmt.Errorf("migrate init: %w", err)
    }
    defer m.Close()

    if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
        return fmt.Errorf("migrate up: %w", err)
    }

    version, _, _ := m.Version()
    log.Printf("migrations up to date at version %d", version)
    return nil
}