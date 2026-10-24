CREATE TABLE tunnel_connection (
    id integer PRIMARY KEY CHECK(id=1),
    endpoint text NOT NULL,
    token text NOT NULL,
    users text[] NOT NULL
);
