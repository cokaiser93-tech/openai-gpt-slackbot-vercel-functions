import { WebClient } from '@slack/web-api'
import { getGPTResponse, generatePromptFromThread } from './_openai'

const slack = new WebClient(process.env.SLACK_BOT_TOKEN)

interface Event {
  channel: string
  ts: string
  thread_ts?: string
}

/**
 * Send a GPT response to a Slack message (fire-and-forget)
 * This function should not await in the request handler to avoid timeouts
 */
export async function sendGPTResponse(event: Event): Promise<void> {
  const { channel, ts, thread_ts } = event
  const threadId = thread_ts ?? ts

  try {
    console.log(`[GPT] Processing mention in channel=${channel}, thread_ts=${threadId}`)

    // Fetch thread messages
    const thread = await slack.conversations.replies({
      channel,
      ts: threadId,
      inclusive: true,
      limit: 100, // Limit API response to 100 messages
    })

    // Generate prompts from thread
    const prompts = await generatePromptFromThread(thread)
    console.log(`[GPT] Generated ${prompts.length} messages for GPT`)

    // Get GPT response
    const gptResponse = await getGPTResponse(prompts)
    const responseText = gptResponse.choices[0]?.message?.content

    if (!responseText) {
      throw new Error('No response content from GPT')
    }

    // Post response to Slack
    await slack.chat.postMessage({
      channel,
      thread_ts: ts,
      text: responseText,
    })

    console.log(`[GPT] Successfully posted response to channel=${channel}`)
  } catch (error) {
    // Log full error for debugging
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[GPT] Error processing mention: ${errorMessage}`, error)

    // Only notify admin about critical errors (not rate limits or timeouts)
    const shouldNotifyAdmin =
      error instanceof Error &&
      !errorMessage.includes('rate') &&
      !errorMessage.includes('timeout') &&
      !errorMessage.includes('429')

    if (shouldNotifyAdmin && process.env.SLACK_ADMIN_MEMBER_ID) {
      try {
        await slack.chat.postMessage({
          channel,
          thread_ts: ts,
          text: `<@${process.env.SLACK_ADMIN_MEMBER_ID}> Error processing GPT request. Check logs for details.`,
        })
      } catch (notifyError) {
        console.error('[GPT] Failed to notify admin:', notifyError)
      }
    }
  }
}
