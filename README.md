# 海上风电气象窗口

运维团队用本服务把海况预报转换为连续的禁航保护段，并复核尚未开始的登乘窗口。预报带来源版本、有效期和时区，撤销记录只针对同一来源版本。脱敏事故数据保存在 `fixtures/incident.json`。

运行环境为 Node.js 20。使用 `npm test` 校验资料，`npm start` 启动本地状态接口，预报缓存和联系人资料不进入版本库（状态文件默认写入 `data/state.json`，可用 `STATE_FILE` 覆盖，重启后自动恢复）。

## 接口

- `POST /forecasts`：接入单条或批量预报。同一来源（`forecastId`）只保留最高 `version`，较新版本替换旧版，`revoked: true` 撤销该来源的保护；低版本后到达被忽略，因此同一批预报无论先后到达都形成相同日历。
- `GET /calendar`：禁航日历。生效预报的有效期展开为连续保护区，跨午夜时段首尾相接，不再断开。
- `POST /requests`：登记登乘窗口申请（`id`、`windowStart`、`windowEnd`）。
- `GET /requests`：申请及其当前状态。
- `GET /desk`：值班台视图，直接区分 `blocked`（受阻，释放回队列）、`review`（已开始，待人工复核）与 `proceed`（确认安全，继续执行）。

窗口状态随每次预报更新自动重算：与保护区重叠且尚未开始的窗口转 `window-held`，已开始的转 `weather-review`，落在保护区外（含相邻时段）的为 `approved`；预报撤销后受阻窗口自动恢复开放。
