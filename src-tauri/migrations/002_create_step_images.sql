-- Step images table for storing hint images attached to test steps
CREATE TABLE IF NOT EXISTS step_images (
    id TEXT PRIMARY KEY NOT NULL,
    scenario_id TEXT NOT NULL,
    image_data TEXT NOT NULL,  -- Raw Base64 (without data: prefix)
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'image/png',
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_step_images_scenario ON step_images(scenario_id);
