Problem Statement
The goal is to build an AI-powered workflow assistant that automates 80-90% of the renewal effort for US-based health insurance brokers, specifically focused on Health Insurance. 

Unlike traditional fully email-based automation, this solution operates entirely over voice calls, where the AI agent proactively calls clients, gathers information, answers questions, and completes renewal steps conversationally. At the end, the AI agent sends the policy documents to the client over an email.

AI Agent Responsibilities (Voice-Based)

The AI agent, through live calls with insured clients, will :
Conduct data gathering (household changes, income updates, dependents, address changes, eligibility-related updates)
Collect necessary documents verbally or by sending email links when required
Review claims / utilization insights
Prepare and submit the renewal application to the carrier/exchange
Handle follow-up voice calls for missing information
Answer client questions using a health insurance knowledge base (plan terms, subsidies, coverage rules, timelines)
Present plan options and help move toward proposal and plan renewal confirmation
Coordinate completion of the binding & enrollment process for renewal
Goals & Objectives
Primary Objectives
Automate 80-90% of broker’s renewal workload
Reduce manual follow-up cycles and time spent chasing clients for information
Standardize renewal workflows across individual and family health insurance segments

Secondary Objectives
Improve customer satisfaction by offering a guided, conversational, human-like voice renewal experience
Ensure complete auditability and compliance through call transcripts, logs and structured workflow documentation


Persona
Broker
Manages hundreds of health insurance clients
Faces heavy renewal-season workloads
Prioritizes accuracy, compliance, and operational speed
Wants automation that reduces repetitive client outreach

Insured/ Clients
Typically slow to respond without reminders
Unsure about what information is needed (income, dependents, documents, etc.)
Prefer a guided, easy-to-understand conversation over a phone call rather than complex forms
Expect simple, empathetic, and clear explanations of plan options and renewal steps


AI Insurance Renewal Agent Workflow
Voice Outreach to the Insured : AI agent places an outbound voice call to the client, explains that renewal is due, and asks for permission to proceed. It sets expectations about what information will be needed
Data Collection & Validation : Through the call, the AI gathers updated household, income, address, dependents, and eligibility details. Any required documents are requested via Email
Submission to Carrier : Once data is complete, the AI prepares the renewal application and submits it to the health insurance carrier. If the carrier asks for clarifications, the AI follows up with the client via phone
Quote Retrieval & Tracking : The system retrieves available renewal plan options, updated premiums, subsidy eligibility, coverage changes
Proposal Preparation : AI agent prepares a simple comparison of available health plans (premiums, deductibles, out-of-pocket max, network, prescriptions)and includes broker recommendations. Presents it to the client
Client Review & Decision : AI agent explains plan options clearly, answers questions using the knowledge base, and captures the client’s final plan choice
Binding & Enrollment : Selected plan is submitted for enrollment / binding. The system triggers issuance of ID cards, confirmation letters and enrollment documents
Delivery & Closeout : The final policy package is shared with the client. Systems are updated, the renewal is marked complete, and next-year reminders are queued.

Sample Conversation

AI Agent Message 1 (Outreach) : 
“Hi John, this is your benefits assistant calling about your health insurance renewal for the upcoming plan year. Shall we get started? This will just take 4-5 minutes of your time.”

Customer Message 1 : 
Sure, go ahead

AI Agent Message 2 (Data collection / Validation) : 
Great! Based on my records, you’re on HumanaChoice H5216-347 PPO, your yearly premium is $4,320, renewing Jan 12. Can you tell me if there are any changes to your household? Do you want to add/ remove spouse, dependents or students?

Customer Message 2 : 
No changes, household is the same

AI Agent Message 3 (Data collection / Validation) : 
I have noted this, John. And your estimated income for next year?

Customer Message 3 : 
$58,000

AI Agent Message 4 (Data collection / Validation) : 
Got it, last year you estimated $45,000. This year, we will go with $58,000. Wanted to check if there are any new medical conditions, surgeries or upcoming tests? Also any changes to your doctors or prescriptions?

Customer Message 4 : 
Not at the moment

AI Agent Message 5 (Data collection / Validation) : 
And any long trips out of state planned?

Customer Message 5 : 
Just 2-3 weeks in summer.

AI Agent Message 6 (Data collection / Validation) : 
Awesome! Since the estimated income has changed. Can you share a recent pay stub, preferably the latest one? You can send that to us at support@suinsurance.com. I’ll be waiting on call, let me know once you are done.

Customer Message 6 : 
Done

AI Agent Message 7 (Submission to carrier and carrier request) : 
Awesome! I just submitted your renewal profile to Humana and they have responded back with some queries. They have asked my 3 questions, please tell me what to respond back with.
Firstly, are there any chronic conditions?
Second - any upcoming diagnostics planned?
Third - You’re a non-tobacco user, right?

Customer Message 7 : 
No chronic condition or diagnostics. Off tobacco since 3-4 years.

AI Agent Message 8 (Quote collection + Proposal preparation + Client Decision) : 
Thanks. Humana has returned with a renewal plan.
Your updated annual premium: $4,450, about 3% increase due to changes in state rules.
Deductible stays at $5,800, coinsurance at 40% and max out-of-pocket has increased to $9,800. 
Our recommendation would be stay on your current plan, it’s still the most cost-effective.
Do you want to know about the alternatives and then make a decision? Or go with the same plan?

Customer Message 8 : 
Yeah, give me all options please.

AI Agent Message 9 (Client Decision) : 
Sure! The other plan alternatives suggested by Humana are : 
HumanaChoice H5216-280 - The yearly premium is $4,600. This plan features a deductible of $6,000 and 40% coinsurance after the deductible, and the out-of-pocket maximum is $7,800.
HumanaChoice H5216-423 - The yearly premium is $4,200. This plan features a deductible of $4,500 and 40% coinsurance after the deductible, and the out-of-pocket maximum is $7,500.
So which one do you want to go for? Do you want to stay on the current HumanaChoice H5216-347 PPO or explore any of these options?


Customer Message 9 : 
Stay with HumanaChoice H5216-347 PPO

AI Agent Message 10 (Binding + Delivery) : 
Excellent choice. Your 2026 HumanaChoice H5216-347 PPO policy is now renewed. I’m sending a secured link on your registered email ID with the following details - the policy contract, schedule of benefits, SBC, Updated ID card, Renewal confirmation. Tell me once you get this, I will wait on the call.

Customer Message 10 : 
Got it

AI Agent Message 11 : 
Thanks for confirming this, John! Your renewal is now complete! I’ll reach out again next year when the pre-renewal window opens. Thanks for being with us another year.


Email format
At the end, an email needs to be sent to client with the secure link to the policy document. Format of email -

Subject : Your insurance policy renewal confirmation from Humana

Body : 
Dear John,

Your insurance policy has been successfully renewed with Humana for the year 2026. 

Please find the secure link where you will be able to access your policy contract, schedule of benefits, SBC, Updated ID card, Renewal confirmation : suinsurance.com/humana/0001

For any queries, please feel free to contact us at +1 650 844 3031 or info@searchunify.com.

Regards
Team SU Insurance


Edge Case

Customer indicates they are busy or they will not be able to talk at the moment
Agent : “That’s totally fine, can you tell us a good time to reach out to you?”
Customer : “Tomorrow, 2pm.”
Agent: “This is noted. Have a nice day.”
– Call gets disconnected –

When the customer is unhappy with the renewal terms

– Customer Message 9 
I want to go ahead with the H216-347. But I will need some discounts. Can you please check and let me know if any discount is possible on the yearly premium?


AI Agent Message 10 (Negotiation with carrier) : 

Hi John,

Thanks for the update. I’ll surely look into it. Let me discuss this with Humana and see what best they can do at their end. I will get back to you within the next 2-3 days.

– Call gets disconnected –


RAG
Apart from the basic workflow, the AI Insurance Renewal agent should also be able to respond to client queries from a knowledge base. Client can ask a query during the flow, the AI agent is expected to only respond from knowledge base and then swiftly bring the client back to the flow.

Knowledge base : Knowledge Base - Health Insurance (HumanaChoice H5216-347 PPO)


