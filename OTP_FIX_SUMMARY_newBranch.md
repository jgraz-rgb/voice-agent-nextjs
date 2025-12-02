# OTP Tool Fixes Applied to newBranchwithMCP Branch

## Issues from Abhijot's Report

### Problem 1: Premature Tool Invocation
**Issue**: Agent was calling `sendGeneralOTP` immediately when mobile number was entered in Step 1, instead of waiting until Step 12 (Self-Declaration & E-Verification).

### Problem 2: Type Misalignment  
**Issue**: The `verifyGeneralOTP` execute function wasn't receiving the `otp_reference_id` parameter that was defined in the schema.

## Solutions Applied

### ✅ Fix 1: Updated `sendGeneralOTP` Tool Description
**File**: `src/app/agentConfigs/kotakInsurance/kotakInsurance/index.ts`

**Before**:
```typescript
description: "Sends OTP to the registered mobile number for e-verification."
```

**After**:
```typescript
description: "CRITICAL: Only call this tool during Step 12 (Self-Declaration & E-Verification) when the user has reached the e-verification stage. DO NOT call this tool immediately after collecting the mobile number in Step 1. Wait until Step 12 to send OTP for application e-verification. Sends OTP to the registered mobile number for e-verification."
```

### ✅ Fix 2: Updated `verifyGeneralOTP` Tool Description
**File**: `src/app/agentConfigs/kotakInsurance/kotakInsurance/index.ts`

**Before**:
```typescript
description: "Verifies the OTP sent for e-verification."
```

**After**:
```typescript
description: "CRITICAL: Only call this tool during Step 12 (Self-Declaration & E-Verification) AFTER sendGeneralOTP has been called. This tool verifies the OTP sent for e-verification. Do not call this tool at any other step in the flow."
```

### ✅ Fix 3: Fixed Parameter Destructuring in `verifyGeneralOTP`

**Before**:
```typescript
execute: async ({
  otp_code,
  phone_number,
}: {
  otp_code: string;
  phone_number: string;
}) => {
```

**After**:
```typescript
execute: async ({
  otp_reference_id,
  otp_code,
  phone_number,
}: {
  otp_reference_id: string;
  otp_code: string;
  phone_number: string;
}) => {
```

Now the `otp_reference_id` parameter is properly received and can be used if needed.

### ✅ Fix 4: Added CRITICAL TOOL INVOCATION RULES to Instructions
**File**: `src/app/agentConfigs/kotakInsurance/kotakInsurance/instructions.ts`

Added new section under CORE OPERATIONAL RULES:

```typescript
### CRITICAL TOOL INVOCATION RULES:
⚠️ **DO NOT call OTP tools prematurely:**
- sendGeneralOTP and verifyGeneralOTP are ONLY for Step 12 (Self-Declaration & E-Verification)
- DO NOT call sendGeneralOTP immediately when mobile number is collected in Step 1
- WAIT until you reach Step 12 before invoking any General OTP tools
- sendAadhaarOTP and verifyAadhaarOTP are ONLY for Step 5 (Aadhaar Verification)
- Each tool has a designated step - follow the step sequence strictly
```

## Expected Behavior After Fixes

1. ✅ Agent collects mobile number in Step 1 WITHOUT calling sendGeneralOTP
2. ✅ Agent progresses through Steps 2-11 without premature OTP invocation
3. ✅ Agent reaches Step 12 and announces e-verification
4. ✅ Agent THEN calls sendGeneralOTP with the phone_number parameter
5. ✅ Agent waits for user to provide OTP
6. ✅ Agent calls verifyGeneralOTP with otp_reference_id, otp_code, and phone_number
7. ✅ All parameters are properly typed and received

## Testing the MCP Service

The `newBranchwithMCP` branch is configured to use an MCP service at:
- **URL**: `http://localhost:8050/mcp`
- **Server Name**: `mobileAuth`
- **Tools**: `send_otp` and `verify_otp`

### To test, you need to:

1. **Start the FastAPI MCP service** on port 8050 (check with Abhijot for the service location)
2. **Start the Next.js app**: `npm run dev`
3. **Navigate to**: http://localhost:3000?agentConfig=kotakInsurance
4. **Test the flow** from Step 1 → Step 12

## Files Modified

1. `/src/app/agentConfigs/kotakInsurance/kotakInsurance/index.ts`
   - Updated `sendGeneralOTP` description with CRITICAL step sequencing
   - Updated `verifyGeneralOTP` description with CRITICAL step sequencing
   - Fixed parameter destructuring in `verifyGeneralOTP` execute function

2. `/src/app/agentConfigs/kotakInsurance/kotakInsurance/instructions.ts`
   - Added CRITICAL TOOL INVOCATION RULES section

## Next Steps

1. **Locate and start the FastAPI MCP service** (should be on port 8050)
2. Test the complete flow to verify OTP is not called prematurely
3. Verify the MCP service connectivity and responses
4. Monitor console logs for any type errors or connection issues
