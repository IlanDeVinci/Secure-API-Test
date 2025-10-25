-- SQLite migration: create tables if they do not exist.
-- This migration is idempotent and can be run multiple times without harm.

PRAGMA foreign_keys = ON;

-- Roles: permissions are stored as individual columns named `can_<perm>`
CREATE TABLE IF NOT EXISTS roles (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	can_get_my_user INTEGER NOT NULL DEFAULT 1,
	can_get_users INTEGER NOT NULL DEFAULT 0,
	can_post_login INTEGER NOT NULL DEFAULT 1,
	can_post_products INTEGER NOT NULL DEFAULT 1,
	can_get_products INTEGER NOT NULL DEFAULT 0,
	can_get_my_products INTEGER NOT NULL DEFAULT 1,
	can_get_bestsellers INTEGER NOT NULL DEFAULT 0,
	can_upload_media INTEGER NOT NULL DEFAULT 0,
	can_create_api_keys INTEGER NOT NULL DEFAULT 1,
	can_read_api_keys INTEGER NOT NULL DEFAULT 1,
	can_delete_api_keys INTEGER NOT NULL DEFAULT 1,
	created_at DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- Users table: stores internal id and public_id used across the API
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	public_id TEXT UNIQUE,
	username TEXT NOT NULL UNIQUE,
	password TEXT NOT NULL,
	email TEXT NOT NULL UNIQUE,
	role_id INTEGER NOT NULL,
	token_version INTEGER NOT NULL DEFAULT 0,
	created_at DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT
);

-- API keys table: stores hashed key, owner, and a JSON array of permissions
CREATE TABLE IF NOT EXISTS api_keys (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	public_id TEXT UNIQUE,
	key_hash TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	owner_user_id INTEGER NOT NULL,
	permissions TEXT, -- JSON array string, e.g. '["get_products","post_products"]'
	disabled INTEGER NOT NULL DEFAULT 0,
	created_at DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Products created locally and mapped to Shopify ids
CREATE TABLE IF NOT EXISTS products (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	public_id TEXT UNIQUE,
	shopify_id TEXT UNIQUE NOT NULL,
	name TEXT,
	images TEXT, -- JSON array string
	created_by INTEGER,
	sales_count INTEGER NOT NULL DEFAULT 0,
	created_at DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	updated_at DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
	FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Indexes to speed up lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_products_created_by ON products(created_by);
CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);

-- Seed some basic roles (ignore if they already exist)
INSERT OR IGNORE INTO roles (id, name, can_post_login, created_at) VALUES
	(1, 'admin', 1, (strftime('%Y-%m-%d %H:%M:%f','now'))),
	(2, 'user', 1, (strftime('%Y-%m-%d %H:%M:%f','now'))),
	(3, 'premium', 1, (strftime('%Y-%m-%d %H:%M:%f','now'))),
	(4, 'ban', 0, (strftime('%Y-%m-%d %H:%M:%f','now')));

-- Give admin all permission flags
UPDATE roles SET
	can_get_users = 1,
	can_get_products = 1,
	can_get_bestsellers = 1,
	can_upload_media = 1
WHERE name = 'admin';

-- Ensure premium role has rights to view products and bestsellers
UPDATE roles SET
	can_get_bestsellers = 1,
	can_upload_media = 1
WHERE name = 'premium';

-- Ensure ban role has no permissions
UPDATE roles SET
	can_get_my_user = 0,
	can_post_login = 0,
	can_post_products = 0,
	can_get_my_products = 0,
	can_create_api_keys = 0,
	can_read_api_keys = 0,
	can_delete_api_keys = 0
WHERE name = 'ban';