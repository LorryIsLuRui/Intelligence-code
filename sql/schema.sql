CREATE TABLE IF NOT EXISTS symbols (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  type ENUM('component', 'util', 'selector', 'type') NOT NULL,
  category VARCHAR(255) NULL,
  path TEXT NOT NULL,
  description TEXT NULL,
  content MEDIUMTEXT NULL,
  meta JSON NULL,
  usage_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dependencies (
  from_id INT NOT NULL,
  to_id INT NOT NULL
);
