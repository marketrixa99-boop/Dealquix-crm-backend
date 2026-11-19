import { Request, Response } from "express";
import { Types } from "mongoose";
import { generateStringeeRestToken } from "../utils/stringeeToken.js";
import { CallLog } from "../models/CallLog.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import axios from "axios";
import { operationsScope } from "../validators/operations.validator.js";
import { AppError } from "../utils/AppError.js";

// Historical calls and recordings remain readable after the provider switch.
export const getLeadCallHistoryController = async (
  req: Request,
  res: Response,
) => {
  try {
    const { leadId } = req.params;

    if (!Types.ObjectId.isValid(String(leadId))) return res.status(400).json({ message: "Invalid lead ID" });
    const lead = await Lead.findOne({ _id: leadId, isDeleted: false, ...operationsScope(req.user!) });
    if (!lead || lead.isDeleted) {
      return res.status(404).json({ message: "Lead not found" });
    }

    const query = { lead: leadId, ...operationsScope(req.user!, undefined, "caller") };

    const calls = await CallLog.find(query)
      .populate("caller", "name email role")
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, data: calls });
  } catch (error: any) {
    return res.status(500).json({ message: error.message });
  }
};

export const getCallLogs = async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 10));
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const skip = (page - 1) * limit;

    const { status, leadId, userId, branchId, search, startDate, endDate } =
      req.query;

    const filter: any = operationsScope(req.user!, branchId ? String(branchId) : undefined, "caller");

    const toObjectId = (value: unknown): unknown => {
      const raw = String(value);
      return Types.ObjectId.isValid(raw) ? new Types.ObjectId(raw) : value;
    };

    if (userId && req.user?.role !== "employee") filter.caller = toObjectId(userId);

    if (status) filter.callStatus = status;
    if (leadId) filter.lead = toObjectId(leadId);

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(`${startDate}T00:00:00.000Z`);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
      }
    }

    if (search) {
      const searchRegex = new RegExp(String(search).slice(0, 150).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

      const matchedLeads = await Lead.find({
        $or: [{ name: searchRegex }, { phone: searchRegex }],
        isDeleted: { $ne: true },
      })
        .select("_id")
        .lean();

      const matchedUsers = await User.find({
        name: searchRegex,
      })
        .select("_id")
        .lean();

      const leadIds = matchedLeads.map((l) => l._id);
      const userIds = matchedUsers.map((u) => u._id);

      filter.$or = [
        { toNumber: searchRegex },
        { fromNumber: searchRegex },
        ...(leadIds.length > 0 ? [{ lead: { $in: leadIds } }] : []),
        ...(userIds.length > 0 ? [{ caller: { $in: userIds } }] : []),
      ];
    }

    const [logs, total, summary] = await Promise.all([
      CallLog.find(filter)
        .populate("lead", "name phone email company avatar")
        .populate("caller", "name email avatar")
        .populate("branch", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CallLog.countDocuments(filter),
      CallLog.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalCalls: { $sum: 1 },
            totalSeconds: { $sum: { $ifNull: ["$duration", 0] } },
            answeredCalls: {
              $sum: {
                $cond: [{ $in: ["$callStatus", ["answered", "ended"]] }, 1, 0],
              },
            },
            missedCalls: {
              $sum: {
                $cond: [
                  { $in: ["$callStatus", ["missed", "rejected", "failed"]] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

    const stats = {
      totalCalls: summary[0]?.totalCalls ?? 0,
      totalSeconds: summary[0]?.totalSeconds ?? 0,
      answeredCalls: summary[0]?.answeredCalls ?? 0,
      missedCalls: summary[0]?.missedCalls ?? 0,
    };

    return res.status(200).json({
      success: true,
      data: logs,
      stats,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error("[Get Call Logs Error]:", error);
    if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, message: error.message });
    return res.status(500).json({ message: error.message });
  }
};

export const getCallLogById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!Types.ObjectId.isValid(String(id))) return res.status(400).json({ message: "Invalid call log ID" });
    const log = await CallLog.findOne({ _id: id, ...operationsScope(req.user!, undefined, "caller") })
      .populate("lead")
      .populate("caller", "name email")
      .populate("branch", "name")
      .lean();

    if (!log) {
      return res.status(404).json({ message: "Call log record not found" });
    }

    return res.status(200).json({ success: true, data: log });
  } catch (error: any) {
    return res.status(500).json({ message: error.message });
  }
};

export const proxyRecordingAudio = async (req: Request, res: Response) => {
  try {
    const { recordingUrl } = req.query;

    if (!recordingUrl || typeof recordingUrl !== "string") {
      return res
        .status(400)
        .json({ message: "recordingUrl query parameter is required" });
    }

    // 1. Only real Stringee hosts — a loose `includes("stringee.com")` check
    // would let any URL through and leak our REST token to it
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(recordingUrl.trim());
    } catch {
      return res.status(400).json({ message: "Invalid recording URL" });
    }
    const host = parsedUrl.hostname.toLowerCase();
    if (host !== "stringee.com" && !host.endsWith(".stringee.com")) {
      return res.status(403).json({ message: "Invalid recording URL domain" });
    }

    // 2. Stringee stores `http://api.stringee.com/...` URLs, but that host is
    // geo-routed: from a non-Asia server (e.g. Render) it lands on a region that
    // rejects our asia-2 key with `keySid invalid`. Call the project's region.
    const apiBase = (
      process.env.STRINGEE_API_BASE_URL || "https://asia-2.api.stringee.com"
    ).replace(/\/+$/, "");
    const cleanUrl = `${apiBase}${parsedUrl.pathname}${parsedUrl.search}`;

    // 3. Generate REST API Token
    const stringeeToken = generateStringeeRestToken();

    // 4. Request audio stream from Stringee using `X-STRINGEE-AUTH`. The
    // browser's Range header is passed through so seeking works (Safari needs it).
    const response = await axios({
      method: "get",
      url: cleanUrl,
      headers: {
        "X-STRINGEE-AUTH": stringeeToken,
        "Accept-Encoding": "identity",
        ...(req.headers.range && { Range: req.headers.range }),
      },
      responseType: "stream",
      decompress: false,
      validateStatus: () => true, // Capture response statuses
    });

    const rawContentType = response.headers["content-type"];
    const contentType =
      typeof rawContentType === "string" ? rawContentType : "audio/mpeg";

    // 5. Handle error / JSON responses from Stringee
    if (
      contentType.includes("application/json") ||
      (response.status !== 200 && response.status !== 206)
    ) {
      let rawData = "";
      response.data.on(
        "data",
        (chunk: Buffer) => (rawData += chunk.toString())
      );
      response.data.on("end", () => {
        console.error(`[Stringee Audio Stream Error ${response.status}]:`, rawData);
        return res.status(response.status || 401).json({
          message: "Stringee audio access rejected",
          error: rawData,
        });
      });
      return;
    }

    // 6. Send CORS & Streaming headers to the browser
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", contentType);

    for (const header of ["content-length", "content-range"]) {
      if (response.headers[header]) {
        res.setHeader(header, String(response.headers[header]));
      }
    }

    res.status(response.status);
    return response.data.pipe(res);
  } catch (error: any) {
    console.error(
      "[Audio Proxy Error]:",
      error?.response?.data || error.message
    );
    return res
      .status(500)
      .json({ message: "Failed to stream recording audio" });
  }
};
