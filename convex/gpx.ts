import { v } from "convex/values"
import { mutation, query } from "./_generated/server"

export const save = mutation({
  args: {
    userId: v.id("users"),
    fileName: v.string(),
    content: v.string(),
    totalDistance: v.optional(v.number()),
    elevationGain: v.optional(v.number()),
    duration: v.optional(v.number()),
    avgPace: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("gpxFiles", {
      userId: args.userId,
      fileName: args.fileName,
      content: args.content,
      totalDistance: args.totalDistance,
      elevationGain: args.elevationGain,
      duration: args.duration,
      avgPace: args.avgPace,
    })
    return id
  },
})

export const list = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("gpxFiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect()
    return files.map((f) => ({
      _id: f._id,
      _creationTime: f._creationTime,
      fileName: f.fileName,
      totalDistance: f.totalDistance,
      elevationGain: f.elevationGain,
      duration: f.duration,
      avgPace: f.avgPace,
    }))
  },
})

export const get = query({
  args: {
    fileId: v.id("gpxFiles"),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId)
    if (!file) throw new Error("File not found")
    return file
  },
})

export const remove = mutation({
  args: {
    fileId: v.id("gpxFiles"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.fileId)
  },
})
