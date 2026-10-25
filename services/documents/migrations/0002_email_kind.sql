-- Raw inbound email files (.eml) are stored by the comms service with kind 'email'.
alter table documents.documents drop constraint documents_kind_check;
alter table documents.documents add constraint documents_kind_check check (kind in (
  'spec_sheet', 'line_drawing', 'shop_drawing', 'finish_sample', 'cfa', 'approval_form',
  'image', 'report', 'photo', 'email', 'email_attachment', 'invoice', 'contract', 'other'));
