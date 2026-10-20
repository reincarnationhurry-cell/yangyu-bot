import { z } from 'zod';
import { biliApi } from '../api/bilibili.js';

/**
 * 注册视频互动工具（点赞/投币/收藏）
 *
 * [qq-bot patch] 上游把这个模块写成了纯占位（三个工具全部直接返回"API 已废弃"），
 * 且 index.js 根本没有 import/注册它。实测结论：旧路径 /x/v2/view/like 确实不可用，
 * 但「没有公开 endpoint」的判断是错的，现行接口都正常：
 *   POST /x/web-interface/archive/like   bvid|aid + like(1赞/2取消) + csrf
 *   POST /x/web-interface/coin/add       bvid|aid + multiply + select_like + csrf
 *   POST /x/v2/fav/video/add · del       aid + add_media_ids|del_media_ids + csrf
 * 这里改成真实实现，对应 API 见 api/bilibili.js 的 videoLike / videoCoin / videoFavorite。
 */
export function registerInteractionTools(server) {
    // ─── 点赞/取消点赞 ─────────────────────────────────────
    server.registerTool('bilibili_video_like', {
        description: '对 B站视频点赞或取消点赞（需要登录态）',
        inputSchema: {
            videoId: z.string().describe('视频 BV 号或 avid'),
            action: z
                .enum(['like', 'unlike'])
                .describe('like=点赞, unlike=取消点赞'),
        },
    }, async (params) => {
        try {
            await biliApi.videoLike({
                videoId: params.videoId,
                action: params.action,
            });
            const verb = params.action === 'like' ? '点赞' : '取消点赞';
            return {
                content: [
                    { type: 'text', text: `✅ ${verb}成功：${params.videoId}` },
                ],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `点赞失败: ${err.message}` }],
                isError: true,
            };
        }
    });

    // ─── 投币 ─────────────────────────────────────────────
    server.registerTool('bilibili_video_coin', {
        description: '给 B站视频投硬币（需要登录态，每个视频最多 2 枚）',
        inputSchema: {
            videoId: z.string().describe('视频 BV 号或 avid'),
            multiply: z
                .number()
                .int()
                .min(1)
                .max(2)
                .default(1)
                .describe('投币数量：1 或 2，默认 1'),
            alsoLike: z
                .boolean()
                .default(false)
                .describe('投币时是否同时点赞'),
        },
    }, async (params) => {
        // [qq-bot patch] 投币前置闸门。
        // 该号社区信用分仅 70，B站投币有信用分门槛，实测稳定返回
        //   -403 账号异常,操作失败
        // 且每失败一次都可能继续掉分（越试越差）。所以在客户端直接拦下，
        // 不让模型消耗尝试次数。信用分养回来后把 BILIBILI_COIN_GUARD 设为 'off' 即可放开。
        if (process.env.BILIBILI_COIN_GUARD !== 'off') {
            return {
                content: [
                    {
                        type: 'text',
                        text: '⏸️ 暂时不能投币：这个号的社区信用分只有 70（满分 100），'
                            + '低于 B站投币门槛，调用只会返回「-403 账号异常」，而且每失败一次可能继续掉分。\n'
                            + '建议先在网页端正常使用一段时间（看视频、点赞、发弹幕）把信用分养回来。\n'
                            + '注意：这个不是工具坏了，重试没有意义。',
                    },
                ],
                isError: true,
            };
        }
        try {
            await biliApi.videoCoin({
                videoId: params.videoId,
                multiply: params.multiply ?? 1,
                alsoLike: params.alsoLike === true,
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `✅ 投币成功：${params.videoId} × ${params.multiply ?? 1} 枚` +
                            (params.alsoLike ? '（已同时点赞）' : ''),
                    },
                ],
            };
        }
        catch (err) {
            const msg = String(err?.message || err);
            // [qq-bot patch] 把风控/余额这类「不是 bug」的失败翻成人话，
            // 否则模型会以为是工具坏了，反复重试。
            let hint = '';
            if (/-403/.test(msg)) {
                hint = '\n原因：账号社区信用分不足（实测 70 分，B站投币有信用分门槛），'
                    + '返回「账号异常」不是工具坏了。正常使用一段时间养回信用分即可。';
            }
            else if (/-401|非法访问|verify_captcha/.test(msg)) {
                hint = '\n原因：触发了 B站风控（人机验证层）。B站的验证码依赖浏览器执行 JS 与鼠标轨迹，'
                    + 'CLI 拿不到有效 token，截图给人点也过不了。正常养号即可，不要反复重试。';
            }
            else if (/硬币不足|余额/.test(msg)) {
                hint = '\n原因：账号硬币不足，需靠等级提升或日常任务积累。';
            }
            return {
                content: [{ type: 'text', text: `投币失败: ${msg}${hint}` }],
                isError: true,
            };
        }
    });

    // ─── 收藏/取消收藏 ─────────────────────────────────────
    server.registerTool('bilibili_video_favorite', {
        description: '收藏或取消收藏 B站视频（需要登录态）',
        inputSchema: {
            videoId: z.string().describe('视频 BV 号或 avid'),
            add: z
                .boolean()
                .default(true)
                .describe('true=添加收藏, false=取消收藏'),
            mediaIds: z
                .string()
                .optional()
                .describe('收藏夹 ID 列表（逗号分隔），默认使用默认收藏夹'),
        },
    }, async (params) => {
        try {
            const mediaIds = params.mediaIds
                ? params.mediaIds.split(',').map((s) => s.trim()).filter(Boolean)
                : [];
            await biliApi.videoFavorite({
                videoId: params.videoId,
                add: params.add !== false,
                mediaIds,
            });
            const verb = params.add !== false ? '收藏' : '取消收藏';
            return {
                content: [
                    { type: 'text', text: `✅ ${verb}成功：${params.videoId}` },
                ],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `收藏失败: ${err.message}` }],
                isError: true,
            };
        }
    });
}
