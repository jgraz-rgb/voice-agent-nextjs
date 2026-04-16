'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { LeadInfo } from '@/app/types';

const ALLOWED_LEADS = [
  { name: 'Arjun Kumar', mobile: 8197162904, AreaOffice: 'Koramangala', propertyLocation: 'Bangalore' },
  { name: 'Arvind Shekhar', mobile: 7837678234, AreaOffice: 'Zirakpur', propertyLocation: 'Mohali' },
  { name: 'Vikas Singh', mobile: 7092678120, AreaOffice: 'Andheri East', propertyLocation: 'Mumbai' }, 
  { name: 'Devesh Dixit', mobile: 7820190872, AreaOffice: 'Andheri East', propertyLocation: 'Mumbai' },
  { name: 'Rahul Ved', mobile: 6235067123, AreaOffice: 'Greater Kailash', propertyLocation: 'Delhi' },
];

interface PreConnectionFormProps {
  isOpen: boolean;
  onSubmit: (leadInfo: LeadInfo) => void;
}

const PreConnectionForm: React.FC<PreConnectionFormProps> = ({ isOpen, onSubmit }) => {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [propertyLocation, setPropertyLocation] = useState('');
  const [areaOffice, setAreaOffice] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!firstName.trim()) {
      newErrors.firstName = 'First name is required';
    }

    if (!lastName.trim()) {
      newErrors.lastName = 'Last name is required';
    }

    const rawPhone = phoneNumber.trim();
    if (!rawPhone) {
      newErrors.phoneNumber = 'Phone number is required';
    } else if (!/^[0-9+\s-()]+$/.test(rawPhone)) {
      newErrors.phoneNumber = 'Invalid phone number format';
    }

    if (!propertyLocation.trim()) {
      newErrors.propertyLocation = 'Property location is required';
    }

    if (!areaOffice.trim()) {
      newErrors.areaOffice = 'Area office is required';
    }

    if (!consentChecked) {
      newErrors.consent = 'Please confirm your consent to proceed';
    }

    // Whitelist validation — all fields must match an allowed lead entry
    if (Object.keys(newErrors).length === 0) {
      const fullName = `${firstName.trim()} ${lastName.trim()}`.toLowerCase();
      const phoneDigits = rawPhone.replace(/\D/g, '');
      const enteredLocation = propertyLocation.trim().toLowerCase();

      const matched = ALLOWED_LEADS.find((lead) => {
        const leadNameLower = lead.name.toLowerCase();
        const leadPhone = String(lead.mobile);
        const leadLocation = lead.propertyLocation.toLowerCase();
        return (
          leadNameLower === fullName &&
          leadPhone === phoneDigits &&
          leadLocation === enteredLocation
        );
      });

      if (!matched) {
        newErrors.phoneNumber = 'The details entered do not match our records. Please check and try again.';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    onSubmit({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phoneNumber: phoneNumber.trim(),
      propertyLocation: propertyLocation.trim(),
      areaOffice: areaOffice.trim(),
    });
  };

  return (
    <Dialog open={isOpen} modal>
      <DialogContent className="sm:max-w-[500px]" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-xl">Housing Insurance Registration Form</DialogTitle>
          <DialogDescription>
            All fields are mandatory
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="firstName">First Name *</Label>
              <Input
                id="firstName"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Enter first name"
                className={errors.firstName ? 'border-red-500' : ''}
              />
              {errors.firstName && (
                <p className="text-sm text-red-500">{errors.firstName}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="lastName">Last Name *</Label>
              <Input
                id="lastName"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Enter last name"
                className={errors.lastName ? 'border-red-500' : ''}
              />
              {errors.lastName && (
                <p className="text-sm text-red-500">{errors.lastName}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="phoneNumber">Phone Number *</Label>
            <Input
              id="phoneNumber"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="90XXXXXXXX"
              className={errors.phoneNumber ? 'border-red-500' : ''}
            />
            {errors.phoneNumber && (
              <p className="text-sm text-red-500">{errors.phoneNumber}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="propertyLocation">Property Location *</Label>
            <Input
              id="propertyLocation"
              value={propertyLocation}
              onChange={(e) => setPropertyLocation(e.target.value)}
              placeholder="Enter property location"
              className={errors.propertyLocation ? 'border-red-500' : ''}
            />
            {errors.propertyLocation && (
              <p className="text-sm text-red-500">{errors.propertyLocation}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="areaOffice">Area Office *</Label>
            <Input
              id="areaOffice"
              value={areaOffice}
              onChange={(e) => setAreaOffice(e.target.value)}
              placeholder="Enter area office"
              className={errors.areaOffice ? 'border-red-500' : ''}
            />
            {errors.areaOffice && (
              <p className="text-sm text-red-500">{errors.areaOffice}</p>
            )}
          </div>

          <div className="pt-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(0,82,156)]"
              />
              <span className="text-xs" style={{ color: 'rgb(69, 79, 91)' }}>
                I confirm that the information provided by me here is accurate. I authorize LICHFL or its Authorized representatives to contact me for any queries and or my documents collection for loan application. This will override registry on DND/NDNC.
              </span>
            </label>
            {errors.consent && (
              <p className="text-sm text-red-500 mt-1">{errors.consent}</p>
            )}
          </div>

          <div className="pt-4">
            <Button
              type="submit"
              size="lg"
              className="w-full text-white font-semibold"
              style={{ backgroundColor: 'rgb(0, 82, 156)' }}
              disabled={
                !firstName.trim() ||
                !lastName.trim() ||
                !phoneNumber.trim() ||
                !propertyLocation.trim() ||
                !areaOffice.trim() ||
                !consentChecked
              }
            >
              Talk to Agent
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default PreConnectionForm;
