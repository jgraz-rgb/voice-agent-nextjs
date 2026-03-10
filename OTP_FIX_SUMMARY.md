# OTP Tool Invocation Fix - Summary

## Issues Identified

Based on the conversation with Abhijot, there were two main issues:

1. **Premature Tool Invocation**: The agent was calling `sendGeneralOTP` immediately when the mobile number was entered in Step 1, instead of waiting until Step 12 (Self-Declaration & E-Verification)

2. **Type Alignment**: The `execute` function in `sendGeneralOTP` wasn't properly receiving the `phone_number` parameter that was defined in the schema

## Solutions Implemented

### 1. Updated `sendGeneralOTP` Tool Description (index.ts)

**Before:**
```typescript
description: 'Sends OTP to the registered mobile number for e-verification.'
```

**After:**
```typescript
description: 'CRITICAL: Only call this tool during Step 12 (Self-Declaration & E-Verification) when the user has reached the e-verification stage. DO NOT call this tool immediately after collecting the mobile number in Step 1. Wait until Step 12 to send OTP for application e-verification. Sends OTP to the registered mobile number for e-verification.'
```

### 2. Fixed Type Alignment in `sendGeneralOTP`

**Before:**
```typescript
execute: async () => {
  const otp_reference_id = `GEN_${Date.now()}`;
  return {
    success: true,
    otp_reference_id,
    message: 'OTP sent successfully',
  };
}
```

**After:**
```typescript
execute: async ({ phone_number }: { phone_number: string }) => {
  const otp_reference_id = `GEN_${Date.now()}`;
  return {
    success: true,
    otp_reference_id,
    message: 'OTP sent successfully',
    phone_number,
  };
}
```

### 3. Updated `verifyGeneralOTP` Tool Description

**Before:**
```typescript
description: 'Verifies the OTP sent for e-verification.'
```

**After:**
```typescript
description: 'CRITICAL: Only call this tool during Step 12 (Self-Declaration & E-Verification) AFTER sendGeneralOTP has been called. This tool verifies the OTP sent for e-verification. Do not call this tool at any other step in the flow.'
```

### 4. Fixed Parameter Usage in `verifyGeneralOTP`

**Before:**
```typescript
execute: async ({ otp_code }: { otp_reference_id: string; otp_code: string }) => {
```

**After:**
```typescript
execute: async ({ otp_reference_id, otp_code }: { otp_reference_id: string; otp_code: string }) => {
```

Added `otp_reference_id` to return object for better traceability.

### 5. Added Critical Tool Invocation Rules to instructions.ts

Added a new section in CORE OPERATIONAL RULES:

```typescript
### CRITICAL TOOL INVOCATION RULES:
⚠️ **DO NOT call OTP tools prematurely:**
- sendGeneralOTP and verifyGeneralOTP are ONLY for Step 12 (Self-Declaration & E-Verification)
- DO NOT call sendGeneralOTP immediately when mobile number is collected in Step 1
- WAIT until you reach Step 12 before invoking any General OTP tools
- sendAadhaarOTP and verifyAadhaarOTP are ONLY for Step 5 (Aadhaar Verification)
- Each tool has a designated step - follow the step sequence strictly
```

## Architecture Approach

Following the pattern from previous OTP implementations:
- **Duplicate and modify** the existing OTP tool structure
- **Update docstrings** with explicit step requirements
- **Align TypeScript types** with the defined parameters
- **Add instruction-level guidelines** to reinforce proper usage

## Expected Behavior After Fix

1. ✅ Agent collects mobile number in Step 1 but DOES NOT call sendGeneralOTP
2. ✅ Agent progresses through Steps 2-11 without premature OTP invocation
3. ✅ Agent reaches Step 12 (Self-Declaration) and announces e-verification
4. ✅ Agent then calls sendGeneralOTP with the mobile_number parameter
5. ✅ Agent waits for user to provide OTP
6. ✅ Agent calls verifyGeneralOTP with both otp_reference_id and otp_code
7. ✅ Type alignment ensures proper parameter passing throughout the flow

## Testing Recommendations

1. Test the complete flow from Step 1 → Step 12
2. Verify that OTP is NOT sent after collecting mobile number in Step 1
3. Verify that OTP IS sent when reaching Step 12
4. Check Docker service connectivity: `http://MOBILE_AuthenticationAPI:7190/send_otp`
5. Monitor console logs for any type errors
6. Verify the curl command still works as expected

## Files Modified

1. `/src/app/agentConfigs/kotakInsurance/index.ts`
   - Updated `sendGeneralOTP` tool description and execute function
   - Updated `verifyGeneralOTP` tool description and parameter usage

2. `/src/app/agentConfigs/kotakInsurance/instructions.ts`
   - Added CRITICAL TOOL INVOCATION RULES section

## Notes

- The existing `sendAadhaarOTP` and `verifyAadhaarOTP` tools follow similar patterns for Step 5
- This approach maintains consistency across all OTP verification steps
- The enhanced descriptions serve as inline documentation for the LLM to follow proper flow
