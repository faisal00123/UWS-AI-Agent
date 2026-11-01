/**
 * Canonical column-alias table shared by the CSV mapper and the import
 * pipeline.
 *
 * There is one alias definition for the whole lead-import surface so the
 * preview (CSV mapper) and the commit path (import pipeline) can never
 * disagree about which header means which field.
 */

/** Logical field -> accepted header aliases (normalised: see headerKey). */
export const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['name', 'businessname', 'company', 'companyname', 'title', 'shopname', 'business', 'brand', 'organisation', 'organization', 'firm', 'clinicname', 'restauranname', 'restaurantname', 'schoolname'],
  category: ['category', 'industry', 'sector', 'businesstype', 'type', 'niche', 'segment'],
  city: ['city', 'location', 'area', 'town', 'district', 'region', 'province'],
  website: ['website', 'url', 'site', 'web', 'domain', 'websiteurl', 'homepage', 'websiturl'],
  phone: ['phone', 'phonenumber', 'phoneno', 'mobile', 'mobileno', 'mobilephone', 'cell', 'cellno', 'telephone', 'tel', 'contactnumber', 'contactno'],
  whatsapp: ['whatsapp', 'whatsapplink', 'whatsapplnumber'],
  email: ['email', 'emailaddress', 'emailid', 'mail', 'eemail'],
  contactPerson: ['contactperson', 'contactpersonname', 'contactname', 'person', 'owner', 'proprietor', 'manager', 'decisionmaker'],
  sourceUrl: ['sourceurl', 'source', 'reference', 'ref', 'sourcelink', 'importedfrom', 'listingurl'],
  requirements: ['notes', 'note', 'requirements', 'requirement', 'comments', 'comment', 'description', 'details', 'lookingfor', 'servicesneeded', 'remarks'],
};

/**
 * Normalise a header so "Business Name", "business_name" and "BUSINESS-NAME"
 * all collapse to the same key.
 */
export function headerKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when `header` can supply the logical `field`. */
export function headerMatchesField(header: string, field: string): boolean {
  const key = headerKey(header);
  const aliases = COLUMN_ALIASES[field];
  return aliases ? aliases.includes(key) : key === headerKey(field);
}
