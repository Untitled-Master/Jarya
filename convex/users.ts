import { v } from "convex/values"
import { mutation, query } from "./_generated/server"

export const signUp = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first()

    if (existing) {
      throw new Error("An account with this email already exists.")
    }

    const userId = await ctx.db.insert("users", {
      name: args.name,
      email: args.email,
      password: args.password,
    })

    return { id: userId, name: args.name, email: args.email }
  },
})

export const signIn = mutation({
  args: {
    email: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first()

    if (!user || user.password !== args.password) {
      throw new Error("Invalid email or password.")
    }

    return { id: user._id, name: user.name, email: user.email }
  },
})

export const getMe = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId)
    if (!user) return null
    return { id: user._id, name: user.name, email: user.email }
  },
})
