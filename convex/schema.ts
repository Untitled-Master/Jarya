import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.string(),
    password: v.string(),
  })
    .index("by_email", ["email"]),

  gpxFiles: defineTable({
    userId: v.id("users"),
    fileName: v.string(),
    content: v.string(),
    totalDistance: v.optional(v.number()),
    elevationGain: v.optional(v.number()),
    duration: v.optional(v.number()),
    avgPace: v.optional(v.number()),
  })
    .index("by_userId", ["userId"]),
})
