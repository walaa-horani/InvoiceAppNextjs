"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "./config/db";
import { Invoices, Customers } from "./config/schema";
import Stripe from "stripe";
import { Resend } from 'resend';
import InvoicePaidEmail from "@/components/email/invoice-paid-email";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const resend = new Resend(process.env.RESEND_API_KEY);
export async function updateStatus(id: number, status: "open" | "paid" | "void" | "uncollectible") {
    await db.update(Invoices).set({ status }).where(eq(Invoices.id, id));

    if (status === 'paid') {
        const [result] = await db.select({
            invoice: Invoices,
            customer: Customers
        }).from(Invoices)
            .innerJoin(Customers, eq(Invoices.customerId, Customers.id))
            .where(eq(Invoices.id, id))
            .limit(1);

        if (result && result.customer.email) {
            try {
                await resend.emails.send({
                    from: 'Invoice App <onboarding@resend.dev>',
                    to: result.customer.email,
                    subject: `Payment Received - Invoice #${id}`,
                    react: InvoicePaidEmail({
                        invoiceId: id.toString(),
                        amount: `$${result.invoice.value.toFixed(2)}`,
                        date: new Date().toLocaleDateString(),
                        customerName: result.customer.name

                    })
                })
            } catch (error) {
                console.error('Failed to send email:', error);
            }
        }
    }
    revalidatePath(`/dashboard/invoices/${id}`, "page");
}

export async function createPayment(invoiceId: number) {
    const [result] = await db.select({
        invoice: Invoices,
        customer: Customers
    }).from(Invoices)
        .innerJoin(Customers, eq(Invoices.customerId, Customers.id))
        .where(eq(Invoices.id, invoiceId))
        .limit(1);




    if (!result) {
        throw new Error("Invoice not found");
    }
    const { invoice, customer } = result;

    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
            {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `Invoice #${invoice.id}`,
                        description: invoice.description,
                    },
                    unit_amount: invoice.value * 100,
                },
                quantity: 1,
            },
        ],
        mode: 'payment',
        success_url: `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/dashboard/invoices/${invoiceId}/payment?status=success`,
        cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/dashboard/invoices/${invoiceId}/payment?status=canceled`,
        customer_email: customer.email,
        metadata: {
            invoiceId: invoiceId.toString(),
        },
    });

    return session.url;

}