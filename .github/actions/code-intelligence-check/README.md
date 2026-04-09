# code-intelligence-check

检测代码重复实现，并在 PR 中自动评论结果。

## 使用方式

### 方式一：Mock 模式（无需 MySQL）

```yaml
# .github/workflows/duplicate-check.yml
name: Duplicate Code Check

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches:
      - main

permissions:
  contents: read
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: lorrylurui/code-intelligence-check@v1
        with:
          is-mock-mode: 'true'
          block-threshold: '0.95'
          warn-threshold: '0.85'
```

### 方式二：连接 MySQL（需要配置 secrets）

```yaml
# .github/workflows/duplicate-check.yml
name: Duplicate Code Check

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches:
      - main

permissions:
  contents: read
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: lorrylurui/code-intelligence-check@v1
        with:
          mysql-host: ${{ secrets.MYSQL_HOST }}
          mysql-port: ${{ secrets.MYSQL_PORT }}
          mysql-user: ${{ secrets.MYSQL_USER }}
          mysql-password: ${{ secrets.MYSQL_PASSWORD }}
          mysql-database: ${{ secrets.MYSQL_DATABASE }}
          mysql-enabled: 'true'
          embedding-service-url: ${{ secrets.EMBEDDING_SERVICE_URL }}
          is-mock-mode: 'false'
```

## 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `is-mock-mode` | 是否使用 mock 模式（无需 MySQL） | `true` |
| `mysql-host` | MySQL 主机地址 | - |
| `mysql-port` | MySQL 端口 | `3306` |
| `mysql-user` | MySQL 用户名 | - |
| `mysql-password` | MySQL 密码 | - |
| `mysql-database` | MySQL 数据库名 | `code_intelligence` |
| `mysql-enabled` | 是否启用 MySQL | `false` |
| `embedding-service-url` | 嵌入服务 URL | - |
| `block-threshold` | 重复阻断阈值 | `0.95` |
| `warn-threshold` | 重复警告阈值 | `0.85` |

## 发布到 GitHub Marketplace

1. 创建 GitHub 仓库（如 `code-intelligence-check`）
2. 推送代码
3. 在 Releases 页面创建 v1 标签
4. 提交到 GitHub Marketplace 审核

## License

MIT