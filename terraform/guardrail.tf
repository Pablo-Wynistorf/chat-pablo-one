# Bedrock Guardrail: keep the chatbot on-topic — it should only talk about Pablo
# (his life, work, projects, certifications, events). Off-topic requests (general
# knowledge, coding help, other people, sensitive advice) are denied. This is a
# hard enforcement layer on top of the system prompt.
resource "aws_bedrock_guardrail" "this" {
  name                      = "${var.project_name}-guardrail"
  description               = "Restrict the pablo.one chatbot to questions about Pablo Wynistorf."
  blocked_input_messaging   = var.guardrail_blocked_message
  blocked_outputs_messaging = var.guardrail_blocked_message

  # A topic policy is evaluated against the model's OUTPUT as well as the input, and
  # there is no per-topic input/output switch. So any topic that a legitimate answer
  # could match will truncate that answer mid-sentence and append the refusal. Every
  # topic below is therefore written to be unambiguous on its own, with no
  # "...unless it's about Pablo" conditions — a classifier cannot evaluate those, and
  # they were the source of false positives.
  topic_policy_config {
    # Bedrock caps each topic `definition` at 200 characters, so the on-topic
    # carve-out has to be terse. Keep an eye on the length when editing: going over
    # fails the apply with a ValidationException rather than a plan error.
    topics_config {
      name       = "OffTopicGeneralKnowledge"
      type       = "DENY"
      definition = "General knowledge, trivia, news or creative writing unrelated to Pablo Wynistorf. His own work, projects, code, tools, certifications, employers and events are on topic."
      examples = [
        "What is the capital of France?",
        "Who won the world cup in 2018?",
        "Write me a poem about the ocean.",
        "Summarise today's news headlines.",
      ]
    }

    topics_config {
      name       = "AdviceForTheVisitor"
      type       = "DENY"
      definition = "Personal, career, medical, legal or financial advice for the visitor, or opinions on public figures. Pablo's own experience and the people he worked with are on topic."
      examples = [
        "Should I quit my job?",
        "Tell me about Elon Musk.",
        "Is this a good investment?",
        "What should I study to get into cloud?",
      ]
    }

    # Replaces the old "TechnicalAssistance" topic, which denied *explaining* code
    # unless the request concerned one of Pablo's projects — a condition no classifier
    # can apply, and one that matched constantly because ~96% of the corpus IS his
    # code. Answers about his own tools were being cut off mid-sentence.
    #
    # This is scoped to the REQUEST to produce something new instead. An answer that
    # describes existing code is not a request, so a legitimate reply shouldn't match
    # it. If it still produces false positives, delete this block — scopeRules() in
    # web/lib/chat.ts covers the same ground and costs nothing to adjust.
    topics_config {
      name       = "BuildSomethingForTheVisitor"
      type       = "DENY"
      definition = "Asking Pablo to write, generate, build or debug new code, scripts, projects or documents for the visitor. Explaining how his own existing projects and code work is on topic."
      examples = [
        "Create a JS project that reacts to an API request.",
        "Write a Python script to sort a list.",
        "Debug this function for me.",
        "Build me a website with HTML and CSS.",
      ]
    }
  }

  # Basic defence against prompt-injection attempts to override the persona.
  content_policy_config {
    filters_config {
      type = "PROMPT_ATTACK"
      # MEDIUM, not HIGH: at HIGH this also flagged terse, non-English messages that
      # were nothing more than clipped follow-up questions.
      input_strength  = "MEDIUM"
      output_strength = "NONE"
    }
  }
}
