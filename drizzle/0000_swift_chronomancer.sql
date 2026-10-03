CREATE TABLE `replicate_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`name` text,
	`encrypted_token` text NOT NULL,
	`updated_at` integer NOT NULL
);
