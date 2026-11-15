\set ON_ERROR_STOP on
\set app_password `cat /run/secrets/app_password`
\set writer_password `cat /run/secrets/writer_password`
\set migration_password `cat /run/secrets/migration_password`
CREATE ROLE commonfield_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'app_password';
CREATE ROLE commonfield_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'writer_password';
CREATE ROLE commonfield_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'migration_password';
ALTER DATABASE commonfield OWNER TO commonfield_migration;
REVOKE ALL ON DATABASE commonfield FROM PUBLIC;
GRANT CONNECT ON DATABASE commonfield TO commonfield_app, commonfield_writer;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO commonfield_migration;
GRANT USAGE ON SCHEMA public TO commonfield_app, commonfield_writer;
