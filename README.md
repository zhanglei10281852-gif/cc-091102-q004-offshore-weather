# 海上风电气象窗口

运维团队用本服务把海况预报转换为连续的禁航保护段，并复核尚未开始的登乘窗口。预报带来源版本、有效期和时区，撤销记录只针对同一来源版本。脱敏事故数据保存在 `fixtures/incident.json`。

运行环境为 Node.js 20。使用 `npm test` 校验资料，`npm start` 启动本地状态接口，预报缓存和联系人资料不进入版本库。

## 核心规则

- **连续保护区**：预报有效期（含带时区偏移的 ISO 时间）整体展开为禁航保护段，跨午夜不切割、不留缝隙；重叠或端点相接的多段自动合并。
- **版本语义（顺序无关）**：按 `forecastId` 分来源，以 `version` 单调递增为准——较新版本替换同来源旧版；同版本重复投递幂等；迟到的旧版本直接忽略；同版本的 `revoked:true` 撤销该来源当前版本。
- **窗口决策**：预报到达时重算全部申请——已开始作业进入危险区间转 `weather-review`（人工复核，系统不自动改回）；尚未开始的已持窗口/已批准申请释放回 `submitted` 队列；确认安全的相邻时段照常执行。占用或批准窗口时若与保护区冲突则拒绝。
- **保存与恢复**：每次变更原子落盘到 `data/state.json`（临时文件 + rename），重启后恢复同一状态，同一批预报无论先后到达都形成相同日历。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 状态接口存活检查 |
| GET | `/timeline` | 当前连续禁航保护段 |
| POST | `/forecasts` | 接入/替换/撤销一条预报 |
| GET | `/requests` | 值班台视图：每个申请带 `category`（`blocked` 受阻 / `review` 待复核 / `proceed` 继续执行 / `queued` 排队 / `cancelled`）及命中的保护段 |
| GET | `/requests/:id` | 单个申请视图 |
| POST | `/requests` | 登记申请 `{id?, vessel?, start, end}` |
| POST | `/requests/:id/transition` | 排班动作 `{status}`：`window-held` 占用 / `approved` 批准 / `submitted` 释放 / `cancelled` 取消 |
| POST | `/requests/:id/review` | 人工复核结论 `{decision: "proceed"|"cancel"}` |

预报消息体示例：

```json
{"forecastId":"SEA-92","version":4,"validFrom":"2026-09-28T23:30:00+08:00","validUntil":"2026-09-29T05:00:00+08:00","hazard":"thunderstorm","revoked":false}
```

存档位置可用 `WEATHER_STATE_FILE` 指定完整路径，或用 `WEATHER_DATA_DIR` 指定目录（默认 `./data/state.json`）；监听端口用 `PORT`（默认 8080）。
