import crypto from 'crypto'
import { sendGPTResponse } from './_chat'

export const config = {
  maxDuration: 30,
}

// Simple in-memory rate limiting: track recent mentions per channel
const recentMentions = new Map<string, number[]>()
const RATE_LIMIT_WINDOW_MS = 60000 // 1 minute
const RATE_LIMIT_MAX_MENTIONS = 10 // Max 10 mentions per minute per channel

/**
 * Check if a request is rate-limited
 */
function isRateLimited(channel: string): boolean {
  const now = Date.now()
  const mentions = recentMentions.get(channel) || []

  // Remove old mentions outside the window
  const recentMentionsInWindow = mentions.filter(
    ts => now - ts < RATE_LIMIT_WINDOW_MS
  )

  if (recentMentionsInWindow.length >= RATE_LIMIT_MAX_MENTIONS) {
    return true
  }

  // Add current mention and update
  recentMentionsInWindow.push(now)
  recentMentions.set(channel, recentMentionsInWindow)

  return false
}

/**
 * Validate Slack request signature
 */
async function isValidSlackRequest(request: Request, rawBody: string): Promise<boolean> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET

  if (!signingSecret) {
    console.warn('[Slack] SLACK_SIGNING_SECRET not configured')
    return false
  }

  const timestamp = request.headers.get('X-Slack-Request-Timestamp')
  const slackSignature = request.headers.get('X-Slack-Signature')

  if (!timestamp || !slackSignature) {
    console.warn('[Slack] Missing required signature headers')
    return false
  }

  // Reject requests older than 5 minutes
  const requestTime = parseInt(timestamp, 10)
  const now = Math.floor(Date.now() / 1000)

  if (Math.abs(now - requestTime) > 300) {
    console.warn('[Slack] Request timestamp too old')
    return false
  }

  // Compute expected signature
  const base = `v0:${timestamp}:${rawBody}`
  const hmac = crypto
    .createHmac('sha256', signingSecret)
    .update(base)
    .digest('hex')
  const computedSignature = `v0=${hmac}`

  const isValid = computedSignature === slackSignature
  if (!isValid) {
    console.warn('[Slack] Invalid request signature')
  }

  return isValid
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()

  try {
    // Parse request body
    let body: any
    try {
      body = JSON.parse(rawBody)
    } catch (e) {
      console.error('[Slack] Failed to parse request body')
      return new Response('Invalid JSON', { status: 400 })
    }

    const requestType = body.type

    // Handle URL verification (no signature validation required)
    if (requestType === 'url_verification') {
      console.log('[Slack] URL verification request')
      return new Response(body.challenge, { status: 200 })
    }

    // Validate request signature
    if (!(await isValidSlackRequest(request, rawBody))) {
      console.error('[Slack] Request validation failed')
      return new Response('Unauthorized', { status: 401 })
    }

    // Handle event callbacks
    if (requestType === 'event_callback') {
      const event = body.event
      const eventType = event?.type
      const channel = event?.channel

      if (eventType === 'app_mention' && channel) {
        // Check rate limiting
        if (isRateLimited(channel)) {
          console.warn(`[Slack] Rate limit exceeded for channel ${channel}`)
          return new Response('Rate limited', { status: 429 })
        }

        // Fire-and-forget: don't await the response
        // This prevents the request handler from timing out
        sendGPTResponse(event).catch(err => {
          console.error('[Slack] Unhandled error in background task:', err)
        })

        return new Response('Accepted', { status: 202 })
      }
    }

    // For any other request type, acknowledge and move on
    return new Response('OK', { status: 200 })
  } catch (error) {
    console.error('[Slack] Unexpected error:', error)
    return new Response('Internal server error', { status: 500 })
  }
}
